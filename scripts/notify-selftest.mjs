#!/usr/bin/env node
/**
 * notify-selftest.mjs —— 交易信的 outbox 與付款通知（0022）的自檢
 *
 * 分兩段，理由與 event-registration-selftest / roster-csv-selftest 相同：這支測試
 * 在沒有資料庫的機器上也必須有意義。
 *
 *   [靜態] 讀 supabase/migrations/0022 與幾支 .ts 的原始碼，守的是**設計不變量**：
 *          claim 是不是一句 SQL、dry run 是不是標 'skipped' 而不是 'sent'、
 *          notify.ts 有沒有 throw、webhook 的第三步在不在第二步之後、
 *          §10 的回填在不在（少了它，套用 migration 的當下就會寄信給每一位歷史
 *          客人）。這些答案就寫在檔案裡，不連線也回答得出來。**永遠會跑。**
 *
 *          ⚠️ 排版那一段**直接 import src/lib/email-templates.ts 本人**，
 *             所以它驗到的是 production 真正用的那一份，不是一份長得很像的複本。
 *             需要 Node ≥ 22.18（原生 TypeScript type stripping）。CI 用的是 24。
 *
 *   [併發] 對一個真的資料庫**同時發請求**。每一次 q() 都是一個獨立的 psql
 *          子行程，也就是一條獨立的連線與一個獨立的交易，所以 Promise.all 出來
 *          的是真正的併發。
 *
 * ── ⚠️ 這支測試不會寄出任何一封信 ────────────────────────────────────────
 * 它一行 `fetch` 都沒有，也不 import src/server/email.ts（那支要
 * `@tanstack/react-start/server-only`，載不起來）。傳輸層由人工用真的 Resend
 * 憑證驗過一次就夠；這裡驗的是 outbox 的機制。
 *
 * ── 為什麼併發段跑本機 PostgreSQL，不是 Management API ──────────────────
 * 這台機器上沒有 SUPABASE_ACCESS_TOKEN，而且**這一期的 migration 還沒套上正式庫**。
 * psql 每呼叫一次就是一條新連線，不需要任何憑證，也不會碰到正式庫。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 NOTIFY_SELFTEST_PG_URL，而那個變數要
 *    自己設；沒設就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * 準備一個可以跑的本機庫（PostgreSQL 14+ 即可，實測 18.3）：
 *
 *     createdb ib_p3_test
 *     NOTIFY_SELFTEST_PG_URL=postgres:///ib_p3_test \
 *     NOTIFY_SELFTEST_APPLY=1 node scripts/notify-selftest.mjs
 *
 * `NOTIFY_SELFTEST_APPLY=1` 會先把 0001–0022 套上去（0008 需要 pg_net / vault /
 * pg_cron，本機沒有，會被跳過；0022 自己的排程那一段有 to_regproc 判斷，缺
 * pg_cron 只會印 warning）。套過一次之後就不用再帶這個變數。
 *
 * 環境變數：
 *   NOTIFY_SELFTEST_PG_URL   本機測試庫的連線字串（併發段的開關）
 *   NOTIFY_SELFTEST_APPLY    設成 1 時先套用 0001–0022
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/notify-selftest.mjs";

const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0022 = join(MIG_DIR, "0022_email_outbox_notify.sql");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 event-registration-selftest 同一套）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected, hint) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}

function checkTrue(label, value, hint) {
  check(label, value === true, true, hint);
}

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串。
 *
 * 這裡曾經是 `existsSync(p) ? readFileSync(p, "utf8") : ""`。問題在於這一支底下大量
 * 的斷言長成 `check("…沒有 X", src.includes("X"), false)` —— 路徑一打錯（或檔案被改名、
 * 搬走），`"".includes("X")` 就是 `false`，那條斷言**靜默通過**，從此永遠是綠的，而且
 * 再也沒有在檢查任何東西。正面斷言會轉紅所以是安全的；只有否定斷言會這樣壞掉。
 * 見 run-selftests.mjs 的「守門 4」。
 */
const readFile = (p) => {
  if (!existsSync(p)) {
    throw new Error(
      `selftest 讀不到檔案：${p}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(p, "utf8");
};

// 守著 readFile() 自己：路徑打錯時它必須炸掉，而不是回空字串讓否定斷言靜默通過。
{
  const ghost = join(ROOT, "__selftest-missing-file-probe__");
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(ghost),
  );
}

/** 把 `--` 開頭的整行拿掉，免得註解裡提到的字串讓 includes() 假性通過。 */
function stripComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/** 拿掉 TypeScript 的註解。這個 repo 的檔頭特別長，少了這一步斷言會全紅。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * 切出單一函式的本體：從 `create or replace function <名字>(` 切到它自己的
 * `comment on function <名字>(`。
 *
 * ⚠️ 只用**函式名**當鍵，不帶參數列。宣告那一行寫的是 `(p_limit integer default 5)`，
 *    而 comment on 寫的是 `(integer)` —— 兩邊本來就不一樣，用完整簽名去比對兩邊
 *    只會兩邊都找不到（這支測試第一次跑就是這樣紅了 28 條）。
 */
function functionBody(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start === -1) return "";
  const end = sql.indexOf(`comment on function ${name}(`, start);
  return sql.slice(start, end === -1 ? sql.length : end);
}

console.log("═══ 交易信 outbox 與付款通知自檢（0022）═══");

// =============================================================================
// [1] migration 檔案盤點
// =============================================================================
console.log("\n[1] migration 檔案盤點");
check("0022 存在", existsSync(MIG_0022), true);

const migrations = existsSync(MIG_DIR)
  ? readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
  : [];
// 0024_blackcat_payment.sql（黑貓 PAY 線上刷卡：orders.payment_url /
// payments.gateway_trans_id / payment_alerts()）是這一期加的。
// 0025_event_speaker.sql（活動掛講者：public.events.speaker_id -> public.artists.id）
// 是這一期加的。它只在 public.events 上加一欄與一個索引，沒有碰這一支在驗的任何
// 東西。0025 自己的內容由 artists-selftest 驗。
// 0026_event_product_link.sql（活動與商品的真連結）加了 events.slug / events.image_key、
// products 對活動來源的唯一索引，以及 admin_upsert_event_with_session()。
// ⚠️ 它**會寫 public.event_sessions**（建／改一場梯次），但它一個字都沒有碰
//    email_outbox、order_notify、那五支 notify 函式，也沒有動 event_sessions 的
//    欄位形狀或 grant —— sessions_due_for_reminder() 讀的還是同一張表的同一批欄位。
//    而且它**永遠不寫 seats_taken**（那一欄只由 reserve/release 在持有列鎖時維護），
//    所以下面每一條斷言原樣成立。0026 自己的內容由 event-product-selftest 驗。
// 0027_event_blocks.sql（活動頁組裝器的資料層）加了 events 的七個 jsonb 清單欄位、
// public.event_blocks、admin_reorder_event_blocks()，並用 create or replace 讓
// admin_upsert_event_with_session() 多吃那七欄。它對 event_sessions 的那一段是逐字
// 照抄 0026 的，email_outbox / order_notify / 那五支 notify 函式在整支檔案裡出現
// 0 次，event_sessions 的欄位形狀與 grant 也沒動 —— sessions_due_for_reminder() 讀的
// 還是同一張表的同一批欄位，下面每一條斷言原樣成立。
check("migrations 共 27 支", migrations.length, 27);
check("0023 是最後一支", migrations[22], "0023_fix_cron_guard.sql");

// ─────────────────────────────────────────────────────────────────────────────
// to_regproc() 不吃簽名 —— 帶括號就永遠回 null，而且不報錯。
//
// 0020 §3 與 0022 §9 都寫成 `to_regproc('cron.schedule(text,text,text)')`，所以
// 那兩支的排程段在**每一台機器上**都被跳過，包含正式庫：dispatch-notify-task
// 從來沒被建立，而 migration 看起來是成功的（只印 warning）。0023 修掉並補建。
//
// 帶簽名要用 to_regprocedure()。這條掃全部 migration，出現 to_regproc('…(' 就紅。
// 這是這個專案第三次踩到「看起來有防護、其實沒有，而且不報錯」——前兩次是遮罩
// 的 slice(-0)（0021 §2）與 CSV forceText 漏引號（58aec58）。
// ─────────────────────────────────────────────────────────────────────────────
{
  const offenders = [];
  for (const f of migrations) {
    const body = readFileSync(join(MIG_DIR, f), "utf8");
    // 先剝掉註解再掃：0023 的檔頭要**說明**這個 bug，本文就會出現這個字串。
    // 守衛要抓的是程式碼，不是文件。（同 4b 對 stripTs 的處理。）
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
    if (/to_regproc\s*\(\s*'[^']*\(/.test(code)) offenders.push(f);
  }
  // 0020 與 0022 是踩到這個坑的那兩支。它們已經套用，依規約不能改（0023 補建了
  // 被跳過的排程）。所以這裡不是「不准有」，而是「只准有這兩支」—— 第三支出現
  // 就代表有人又寫了一次，那時候還來得及在套用前修掉。
  check(
    "只有 0020／0022 用了 to_regproc() 帶簽名（新的不准再有）",
    offenders.join(","),
    "0020_event_sessions_registrations.sql,0022_email_outbox_notify.sql",
  );
}
// 這一期不准動到既有的 0001–0021，所以它們也必須都還在。
for (let n = 1; n <= 21; n += 1) {
  const prefix = String(n).padStart(4, "0");
  check(
    `migration ${prefix} 仍在`,
    migrations.some((f) => f.startsWith(`${prefix}_`)),
    true,
  );
}

const sql0022 = readFile(MIG_0022);
const exec0022 = stripComments(sql0022);

// 反空殼：先證明檔案真的有內容，否則下面每一條 includes() 都是假性結果。
checkTrue(
  "反空殼：0022 不是空檔（> 8000 字）",
  exec0022.length > 8000,
  `實際 ${exec0022.length} 字`,
);
checkTrue("0022 有 begin; … commit;", /^begin;/m.test(exec0022) && /^commit;/m.test(exec0022));

// =============================================================================
// [2] 0022 不動既有的 0001–0021
// =============================================================================
console.log("\n[2] 0022 不動既有的結構");

// 這一期沒有任何 drop —— 前幾期放寬 CHECK 用的是 drop constraint + add constraint，
// 而這一期一條 CHECK 都沒有動。
check("沒有 drop function", /drop\s+function/i.test(exec0022), false);
check("沒有 drop table", /drop\s+table/i.test(exec0022), false);
check("沒有 drop constraint", /drop\s+constraint/i.test(exec0022), false);
check("沒有 drop view", /drop\s+view/i.test(exec0022), false);

// ⚠️ pii_access_log 一個字都沒碰：寄信不是「有人在查資料」（0019 §1.1 的線）。
//    每寄一封提醒信就寫一列 log，三個月後那張表 99% 是機器寫的。
check("完全沒有碰 pii_access_log", /pii_access_log/.test(exec0022), false);
check("完全沒有碰 pii_log_access", /pii_log_access/.test(exec0022), false);

// 名單那個 view 是 0021 的，這一期只 join 它，不重新定義。
check(
  "沒有重新定義 admin_event_roster",
  /create\s+or\s+replace\s+view\s+public\.admin_event_roster/i.test(exec0022),
  false,
);
checkTrue(
  "但有 join admin_event_roster（on_roster 的唯一定義）",
  /admin_event_roster/.test(exec0022),
);

// 0020 的兩支寫入函式也不能被動到。
for (const fn of ["reserve_session_seat", "release_session_seat", "expire_unpaid_orders"]) {
  check(
    `沒有重新定義 ${fn}`,
    new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}`, "i").test(exec0022),
    false,
  );
}

// alter table 只准打在這一期自己建的兩張表上。
const alters = exec0022.match(/alter table\s+(?:if exists\s+)?([\w.]+)/gi) ?? [];
const alterTargets = [...new Set(alters.map((a) => a.split(/\s+/).pop()))].sort();
check("alter table 只打在這一期自己的三張表", alterTargets, [
  "public.email_copy",
  "public.email_outbox",
  "public.notify_epoch",
]);

// =============================================================================
// [3] email_outbox 的形狀
// =============================================================================
console.log("\n[3] email_outbox：dedupe_key 是冪等保證，skipped 不是 sent");

checkTrue(
  "建了 public.email_outbox",
  /create table if not exists public\.email_outbox/.test(exec0022),
);
checkTrue(
  "dedupe_key 是 not null unique —— 冪等保證本身",
  /dedupe_key\s+text\s+not null\s+unique/.test(exec0022),
  "少了 unique，重送的 webhook 會讓客人收到兩封一樣的信",
);

// 四種狀態，缺一不可。skipped 是這一期與快樂手不同的地方。
const statusCheck = (exec0022.match(/check \(status in \([^)]*\)\)/) ?? [""])[0];
for (const s of ["pending", "sent", "failed", "skipped"]) {
  checkTrue(`status CHECK 含 '${s}'`, statusCheck.includes(`'${s}'`), statusCheck);
}
check(
  "status 沒有 'sending' 這種中間狀態",
  /'sending'/.test(exec0022),
  false,
  "多一個中間狀態就多一種「程序被砍掉之後卡住沒人接手」的可能（0022 §4）",
);

// RLS：與 0005 / 0020 同一個形狀。
for (const t of ["email_outbox", "email_copy"]) {
  checkTrue(`${t} 開 RLS`, exec0022.includes(`alter table public.${t} enable row level security`));
  checkTrue(
    `${t} 對 anon / authenticated 零 grant`,
    exec0022.includes(`revoke all on table public.${t} from anon, authenticated`),
  );
  checkTrue(
    `${t} 只給 service_role`,
    exec0022.includes(`grant all  on table public.${t} to service_role`),
  );
}
check(
  "email_outbox 沒有任何 create policy（零 policy = 全部拒絕）",
  /create policy[^;]*email_outbox/i.test(exec0022),
  false,
);
// notify_epoch 只有一列、只給 select —— 它是回填用的標記，沒有人要寫它。
checkTrue(
  "notify_epoch 開 RLS",
  /alter table public\.notify_epoch enable row level security/.test(exec0022),
);
checkTrue(
  "notify_epoch 對 anon / authenticated 零 grant",
  /revoke all    on table public\.notify_epoch from anon, authenticated/.test(exec0022),
);
checkTrue(
  "notify_epoch 只給 service_role 讀",
  /grant  select on table public\.notify_epoch to service_role/.test(exec0022),
);
checkTrue(
  "notify_epoch 只有一列（check id = 1）",
  /id\s+smallint primary key check \(id = 1\)/.test(exec0022),
);

// =============================================================================
// [4] claim 是一句 SQL（相對快樂手的改良 1）
// =============================================================================
console.log("\n[4] claim_email_batch：挑列與佔位同一句");

const claimBatch = functionBody(exec0022, "public.claim_email_batch");
checkTrue("反空殼：切得到 claim_email_batch 的函式體", claimBatch.length > 200);
checkTrue(
  "用 for update skip locked 挑列",
  /for update skip locked/.test(claimBatch),
  "少了它，兩個並行的 flush 會拿到重疊的批次，同一封信被寄兩次",
);
checkTrue(
  "挑列與 update 是同一句（update … where id in (select …)）",
  /update public\.email_outbox[\s\S]*where o\.id in \([\s\S]*select/.test(claimBatch),
);
checkTrue("回傳被佔住的那幾列（returning）", /returning o\.id, o\.dedupe_key/.test(claimBatch));
checkTrue(
  "attempts 在送出之前就 +1",
  /attempts\s*=\s*o\.attempts \+ 1/.test(claimBatch),
  "放在成功之後的話，一個每次都讓行程當掉的信會被無限重試",
);
checkTrue("佔位就把 next_attempt_at 推到未來", /next_attempt_at\s*=\s*now\(\)/.test(claimBatch));
// 反面對照：整支函式裡只有一句 update（沒有退化成「先 select 再逐列 CAS」）。
check(
  "claim_email_batch 裡只有一句 update",
  (claimBatch.match(/\bupdate public\.email_outbox\b/g) ?? []).length,
  1,
);

// =============================================================================
// [5] 退避
// =============================================================================
console.log("\n[5] 退避：2^n，上限 360 分");

const backoff = functionBody(exec0022, "public.email_backoff_minutes");
checkTrue("反空殼：切得到 email_backoff_minutes", backoff.length > 100);
checkTrue("是 2 的冪次", /2::numeric \^/.test(backoff));
checkTrue("上限 360 分（6 小時）", /least\(360/.test(backoff));
checkTrue(
  "指數也夾在 12（否則 2^100 會在 ::integer 溢位並讓整個 claim 失敗）",
  /least\(greatest\(coalesce\(p_attempts, 1\), 1\), 12\)/.test(backoff),
  "只寫 least(360, …) 的話，「上限 360」是靠呼叫端不亂傳才成立的",
);
// 驗收條件寫的是「失敗 3 次後 8 分鐘」——那就是 2^3。
check("2^3 = 8（驗收條件的那個數字）", 2 ** 3, 8);
checkTrue("fail_email 的上限預設是 8 次", /p_max_attempts integer default 8/.test(exec0022));
checkTrue(
  "repo 的 EMAIL_MAX_ATTEMPTS 與 SQL 預設值一致",
  /EMAIL_MAX_ATTEMPTS = 8/.test(readFile(join(ROOT, "src/server/repos/email-outbox.ts"))),
);

// =============================================================================
// [6] purge：清內文，不清憑據（相對快樂手的改良 2）
// =============================================================================
console.log("\n[6] purge_sent_email_bodies：清內文，保留 subject / dedupe_key / sent_at");

const purge = functionBody(exec0022, "public.purge_sent_email_bodies");
checkTrue("反空殼：切得到 purge_sent_email_bodies", purge.length > 200);
checkTrue("清 body_text", /body_text\s*=\s*''/.test(purge));
checkTrue("清 body_html", /body_html\s*=\s*''/.test(purge));
checkTrue("留下 body_purged_at 當痕跡", /body_purged_at\s*=\s*now\(\)/.test(purge));
for (const keep of ["subject", "dedupe_key", "sent_at", "provider_id"]) {
  check(`不動 ${keep}`, new RegExp(`${keep}\\s*=`).test(purge), false);
}
check(
  "不清 to_email",
  /to_email\s*=/.test(purge),
  false,
  "清掉之後「這封信到底寄到哪裡」就永遠答不出來了 —— 而那正是客訴時要回答的問題",
);
checkTrue("冪等：只碰還沒清過的列", /body_purged_at is null/.test(purge));

// =============================================================================
// [7] 明文 email 不離開資料庫
// =============================================================================
console.log("\n[7] 明文 email 由 SQL 自己 join，不從呼叫端傳進來");

const enqOrder = functionBody(exec0022, "public.enqueue_order_email");
const enqRegs = functionBody(exec0022, "public.enqueue_registration_emails");
checkTrue("反空殼：切得到兩支 enqueue", enqOrder.length > 200 && enqRegs.length > 200);

// 兩支的參數列都沒有 email / to_email —— 地址進不來，也就出不去。
check(
  "enqueue_order_email 的參數沒有地址",
  /p_(to_)?email/.test(enqOrder.split("as $$")[0]),
  false,
);
check(
  "enqueue_registration_emails 的參數沒有地址",
  /p_(to_)?email/.test(enqRegs.split("as $$")[0]),
  false,
);
checkTrue("enqueue_order_email 從 orders.customer_email join", /o\.customer_email/.test(enqOrder));
checkTrue(
  "enqueue_registration_emails 從 event_registrations.email join",
  /join public\.event_registrations r/.test(enqRegs),
);
checkTrue(
  "兩支都回數字／布林，不回地址",
  /returns boolean/.test(enqOrder) && /returns integer/.test(enqRegs),
);

// ⚠️ 名單條件不可以有第二份。
checkTrue(
  "enqueue_registration_emails 用 on_roster 當閘門",
  /join public\.admin_event_roster v/.test(enqRegs) && /v\.on_roster/.test(enqRegs),
);
check(
  "enqueue_registration_emails 裡沒有 'paid' 字面值",
  /'paid'/.test(enqRegs),
  false,
  "「誰在簽到表上」只定義在 0021 §3 的 view 裡（roster-csv-selftest 守著同一條線）",
);
checkTrue(
  "兩支都 on conflict do nothing（冪等）",
  /on conflict \(dedupe_key\) do nothing/.test(enqOrder) &&
    /on conflict \(dedupe_key\) do nothing/.test(enqRegs),
);

// =============================================================================
// [8] claim_order_notify：用掉那個預留了五期的 'notify'
// =============================================================================
console.log("\n[8] claim_order_notify：形狀對應 0007");

const claimNotify = functionBody(exec0022, "public.claim_order_notify");
checkTrue("反空殼：切得到 claim_order_notify", claimNotify.length > 400);
checkTrue(
  "閘門 1：orders 列鎖",
  /from public\.orders o where o\.id = p_order_id for update/.test(claimNotify),
  "少了它，兩邊會同時讀到「還沒有 notify 列」（0007 檔頭的原話）",
);
checkTrue("閘門 1 也擋沒付款的訂單", /payment_status <> 'paid'/.test(claimNotify));
checkTrue(
  "閘門 2：order_post_payment_log 的 upsert-claim",
  /insert into public\.order_post_payment_log/.test(claimNotify),
);
checkTrue("step 用的就是 'notify'", /values \(p_order_id, 'notify'\)/.test(claimNotify));
checkTrue(
  "只放行「沒完成，而且（失敗過 or 過期）」的列",
  /completed_at is null/.test(claimNotify) &&
    /error_message is not null/.test(claimNotify) &&
    /claimed_at < now\(\) - p_stale_after/.test(claimNotify),
);
checkTrue(
  "分得出 already_sent 與 locked",
  /'already_sent'/.test(claimNotify) && /'locked'/.test(claimNotify),
);

// 0005 那條 CHECK 從來沒有被改過，'notify' 一直都在裡面。
const sql0005 = readFile(join(MIG_DIR, "0005_commerce_orders.sql"));
checkTrue(
  "0005 的 step CHECK 本來就有 'notify'（這一期只是把它用起來）",
  /check \(step in \('invoice','logistics','notify'\)\)/.test(sql0005),
);
check("0022 沒有去改 0005 的那條 CHECK", /step in \(/.test(exec0022), false);

// =============================================================================
// [9] ⚠️ 回填 —— 少了它，套用當下就會寄信給每一位歷史客人
// =============================================================================
console.log("\n[9] §10 回填：歷史已付款訂單一律標成已處理");

checkTrue(
  "有回填 order_post_payment_log 的 notify 列",
  /insert into public\.order_post_payment_log \(order_id, step, claimed_at, completed_at, error_message\)/.test(
    exec0022,
  ),
  "沒有這一段，notify_backlog() 第一次跑就會把每一張歷史已付款訂單判成「還沒通知」",
);
const backfill = (exec0022.match(
  /create table if not exists public\.notify_epoch[\s\S]*?on conflict \(order_id, step\) do nothing;/,
) ?? [""])[0];
checkTrue("反空殼：切得到回填那一段", backfill.length > 100);
checkTrue("回填的是 'notify'", /'notify'/.test(backfill));
checkTrue(
  "回填把 completed_at 設成 now()（＝這一步關掉了）",
  /completed_at/.test(backfill) && /now\(\)/.test(backfill),
);
checkTrue(
  "回填留下為什麼（error_message）",
  /skipped_backfill/.test(backfill),
  "只寫 completed_at 等於謊稱寄過了",
);
checkTrue("回填只碰已付款的訂單", /where o\.payment_status = 'paid'/.test(backfill));
checkTrue(
  "回填冪等（on conflict do nothing）",
  /on conflict \(order_id, step\) do nothing/.test(backfill),
);
// ⚠️ on conflict do nothing 只保證「不出錯」，不保證冪等 —— 見 0022 §10 那一大段。
checkTrue(
  "回填以 notify_epoch 為界（否則第二次套用會把新客人的通知也關掉）",
  /cross join public\.notify_epoch e/.test(backfill) && /< e\.started_at/.test(backfill),
  "重跑整個 migrations 資料夾就會發生，而且完全不會報錯",
);
checkTrue(
  "用 coalesce(paid_at, created_at) 而不是裸的 paid_at",
  /coalesce\(o\.paid_at, o\.created_at\)/.test(backfill),
  "paid 但 paid_at 是 null 的列否則會在每一次套用時都被回填一次",
);
checkTrue(
  "notify_epoch 的時間只在第一次套用時寫下（on conflict do nothing）",
  /insert into public\.notify_epoch \(id\) values \(1\) on conflict \(id\) do nothing/.test(
    exec0022,
  ),
);

// =============================================================================
// [10] 排程：三支永遠不撞在同一個 tick
// =============================================================================
console.log("\n[10] 排程 '6-56/10' 與既有兩支不相交");

checkTrue("排了 dispatch-notify-task", /'dispatch-notify-task'/.test(exec0022));
checkTrue("排程字串是 6-56/10", /'6-56\/10 \* \* \* \*'/.test(exec0022));
checkTrue(
  "cron 只呼叫 dispatch_notify_task()",
  /select public\.dispatch_notify_task\(\)/.test(exec0022),
);

// 真的算一次，不是相信註解。
const minutesOf = (spec) => {
  const m = /^(\d+)-(\d+)\/(\d+)$/.exec(spec);
  if (m) {
    const out = [];
    for (let v = Number(m[1]); v <= Number(m[2]); v += Number(m[3])) out.push(v);
    return out;
  }
  const s = /^\*\/(\d+)$/.exec(spec);
  if (s) {
    const out = [];
    for (let v = 0; v < 60; v += Number(s[1])) out.push(v);
    return out;
  }
  return [];
};
const expire = minutesOf("*/5");
const invoice = minutesOf("3-53/10");
const notifyMins = minutesOf("6-56/10");
check("notify 的分鐘數", notifyMins, [6, 16, 26, 36, 46, 56]);
check(
  "notify ∩ expire = ∅",
  notifyMins.filter((m) => expire.includes(m)),
  [],
);
check(
  "notify ∩ invoice = ∅",
  notifyMins.filter((m) => invoice.includes(m)),
  [],
);
check(
  "invoice ∩ expire = ∅（0008 當時算過的，順便再驗一次）",
  invoice.filter((m) => expire.includes(m)),
  [],
);

// 0008 的排程字串沒有被這一期改掉。
const sql0008 = readFile(join(MIG_DIR, "0008_invoice_cron.sql"));
checkTrue("0008 仍然是 3-53/10", /'3-53\/10 \* \* \* \*'/.test(sql0008));

// =============================================================================
// [11] 密鑰：Vault，不進 git，也不進 cron.job.command
// =============================================================================
console.log("\n[11] 密鑰");

checkTrue("讀 vault.decrypted_secrets", /vault\.decrypted_secrets/.test(exec0022));
checkTrue("用新的 notify_tasks_endpoint_url", /'notify_tasks_endpoint_url'/.test(exec0022));
checkTrue("沿用既有的 tasks_secret", /'tasks_secret'/.test(exec0022));
check(
  "⚠️ migration 不建立 secret（secret 不進 git）",
  /vault\.create_secret/.test(exec0022),
  false,
  "檔頭 §0.8 寫了要手動建，這裡守著它真的沒被寫進 migration",
);
checkTrue("缺 secret 時 raise 而不是安靜跳過", /MISSING_VAULT_SECRET/.test(exec0022));
// 檔頭的說明裡要出現那一句 create_secret 給人照抄（註解裡有、執行段沒有）。
checkTrue("檔頭有教怎麼手動建 secret", /vault\.create_secret/.test(sql0022));

// =============================================================================
// [12] 權限：SECURITY DEFINER 不可以讓瀏覽器的金鑰碰到
// =============================================================================
console.log("\n[12] 權限");

const definerFns = [...exec0022.matchAll(/create or replace function (public\.\w+)\(/g)].map(
  (m) => m[1],
);
checkTrue("反空殼：抓得到這一期新增的函式", definerFns.length >= 12, definerFns.join(", "));
const grantBlock = (exec0022.match(/foreach sig in array array\[[\s\S]*?\]\s*\n\s*loop/) ?? [
  "",
])[0];
for (const fn of definerFns) {
  if (fn === "public.dispatch_notify_task") continue; // 它單獨處理（連 service_role 都不給）
  checkTrue(
    `${fn}() 進了 revoke/grant 清單`,
    grantBlock.includes(`${fn}(`),
    grantBlock.slice(0, 200),
  );
}
checkTrue("清單裡 revoke from public", /revoke execute on function %s from public/.test(exec0022));
checkTrue(
  "清單裡 revoke from anon, authenticated",
  /revoke execute on function %s from anon, authenticated/.test(exec0022),
);
checkTrue(
  "清單裡 grant to service_role",
  /grant  execute on function %s to service_role/.test(exec0022),
);
checkTrue(
  "dispatch_notify_task 連 service_role 都不給（只有 cron 打得到）",
  /revoke execute on function public\.dispatch_notify_task\(\) from public/.test(exec0022) &&
    !/grant execute on function public\.dispatch_notify_task/.test(exec0022),
);

// =============================================================================
// [13] notify.ts：永不 throw、有 Promise.race
// =============================================================================
console.log("\n[13] src/server/notify.ts");

const notifyTs = readFile(join(ROOT, "src/server/notify.ts"));
const notifyCode = stripTs(notifyTs);
checkTrue("反空殼：notify.ts 不是空檔", notifyTs.length > 3000);
check(
  "⚠️ 沒有任何 throw",
  /\bthrow\b/.test(notifyCode),
  false,
  "它跑在 PayUni webhook 的成功路徑上；throw 出去換來的是無止盡的重送",
);
checkTrue(
  "triggerNotifyAfterPayment 有 Promise.race 逾時保護",
  /export async function triggerNotifyAfterPayment[\s\S]*?Promise\.race/.test(notifyCode),
  "理由同 invoice-issuer.ts:413-440",
);
checkTrue("逾時有自己的 reason，看得出是逾時", /notify_timeout/.test(notifyCode));
checkTrue(
  "claim → 做 → finish/fail 三段都在",
  /claimOrderNotify/.test(notifyCode) &&
    /finishOrderNotify/.test(notifyCode) &&
    /failOrderNotify/.test(notifyCode),
);
checkTrue(
  "提醒信用 loadPaidRoster（不自己寫一次條件）",
  /loadPaidRoster\(/.test(notifyCode),
  "否則會出現「有人收到提醒卻不在簽到表上」",
);
checkTrue("報名成功信用 loadPaidRosterByOrder", /loadPaidRosterByOrder\(/.test(notifyCode));
check(
  "notify.ts 裡沒有 'paid' 字面值",
  /["']paid["']/.test(notifyCode),
  false,
  "要判斷就用 on_roster —— 那個條件只定義在 0021 §3 的 view 裡",
);
checkTrue(
  "dry run 標 skipped 不是 sent",
  /skipped: isDryRun/.test(notifyCode),
  "標成 sent 的話，一個忘了設金鑰的正式環境會顯示「全部寄出成功」",
);

// dedupe_key 的三種格式只在一個地方組。
checkTrue("dedupeKeys 集中定義", /export const dedupeKeys = \{/.test(notifyCode));
for (const [name, prefix] of [
  ["orderPaid", "order_paid:"],
  ["registrationTicket", "registration_ticket:"],
  ["sessionReminder", "session_reminder:"],
]) {
  checkTrue(`dedupeKeys.${name} 的前綴是 ${prefix}`, notifyCode.includes(`\`${prefix}`));
}

// =============================================================================
// [14] webhook 的第三步在第二步之後
// =============================================================================
console.log("\n[14] payuni-webhook.ts：貨 → 憑證 → 信");

const webhookTs = readFile(join(ROOT, "src/server/payuni-webhook.ts"));
const webhookCode = stripTs(webhookTs);
const iInventory = webhookCode.indexOf("commitInventoryForOrder(order.id)");
const iInvoice = webhookCode.indexOf("triggerInvoiceAfterPayment(order.id)");
const iNotify = webhookCode.indexOf("triggerNotifyAfterPayment(order.id)");
checkTrue("反空殼：三個呼叫都找得到", iInventory > 0 && iInvoice > 0 && iNotify > 0);
checkTrue("庫存在發票之前", iInventory < iInvoice);
checkTrue("發票在寄信之前", iInvoice < iNotify, "信的失敗最可補救（outbox 重試八次），所以排最後");
checkTrue(
  "webhook 沒有因為寄信失敗就回 5xx",
  /notifyOutcome\.ok/.test(webhookCode) &&
    !/notifyOutcome[\s\S]{0,120}return text\([^)]*5\d\d/.test(webhookCode),
);

// 信不帶發票號碼：webhook 不把 invoice 的結果傳給 notify。
check(
  "triggerNotifyAfterPayment 只收 order.id（信不帶發票號碼）",
  /triggerNotifyAfterPayment\(order\.id\)/.test(webhookCode),
  true,
  "發票會逾時，等它就等於讓信也不寄（0022 §0.3）",
);

// =============================================================================
// [15] server.ts 的路徑表有四條
// =============================================================================
console.log("\n[15] src/server.ts");

const serverTs = readFile(join(ROOT, "src/server.ts"));
const serverCode = stripTs(serverTs);
// ⚠️ 這張表是**刻意的絆線**：src/server.ts 檔頭 L21-24 的規矩是「要再加路徑前，
//    先確認它真的不能用 createServerFn 表達」。加了路徑就一定會讓這裡紅一次，
//    然後有人必須回來把新路徑寫進這張表 —— 那一刻就是那個確認發生的時候。
//
//    這一期加了兩條，都是黑貓 PAY（統一客樂得 COCS）的外部入口：
//      BLACKCAT_APN_PATH     金流商的伺服器送 application/json POST
//      BLACKCAT_RETURN_PATH  客人的瀏覽器被 302 過來，帶一串 query string
//    兩者都不是瀏覽器發起的 RPC，createServerFn 表達不了。
const paths = [
  "BLACKCAT_APN_PATH",
  "BLACKCAT_RETURN_PATH",
  "PAYUNI_WEBHOOK_PATH",
  "INVOICE_TASK_PATH",
  "PURGE_SCANS_TASK_PATH",
  "NOTIFY_TASK_PATH",
];
for (const p of paths) {
  checkTrue(`${p} 有被攔`, new RegExp(`pathname === ${p}`).test(serverCode));
}
check(
  "路徑表恰好六條（多一條就要回來寫進上面那張表）",
  (serverCode.match(/pathname === [A-Z_]+/g) ?? []).length,
  paths.length,
);
// 比對的是「路徑條數」而不是一個寫死的數字：這樣下次加路徑時，這一條會跟著
// 上面那張表一起走，紅的只會是「表沒更新」那一條，不會多紅一條不相干的。
checkTrue(
  "每條路徑都用 dynamic import（service_role 不在模組載入時被拉進來）",
  (serverCode.match(/await import\("@\/server\//g) ?? []).length === paths.length,
);
// 檔頭那張表要說明為什麼它不能用 createServerFn 表達（src/server.ts L21-24 的規矩）。
checkTrue(
  "檔頭說明了 NOTIFY_TASK_PATH 為什麼不能用 createServerFn",
  /NOTIFY_TASK_PATH[\s\S]{0,600}createServerFn/.test(serverTs),
);

// =============================================================================
// [16] task endpoint：密鑰閘門與四件事的順序
// =============================================================================
console.log("\n[16] /api/tasks/notify");

const tasksTs = readFile(join(ROOT, "src/server/task-endpoints.ts"));
const tasksCode = stripTs(tasksTs);
checkTrue(
  "路徑常數是 /api/tasks/notify",
  /NOTIFY_TASK_PATH = "\/api\/tasks\/notify"/.test(tasksCode),
);
const notifyHandler = tasksCode.slice(tasksCode.indexOf("export async function handleNotifyTask"));
checkTrue("反空殼：切得到 handleNotifyTask", notifyHandler.length > 500);
checkTrue(
  "缺密鑰回 503",
  /if \(!secret\) return text\("service unavailable", 503\)/.test(notifyHandler),
);
checkTrue("密鑰不符回 404", /return text\("not found", 404\)/.test(notifyHandler));
checkTrue(
  "常數時間比對",
  /secretMatches\(url\.searchParams\.get\("k"\), secret\)/.test(notifyHandler),
);
check(
  "連 body 都不解析",
  /req\.(json|text|formData)\(\)/.test(notifyHandler),
  false,
  "這條路徑會寄出真的信，所以要在解析任何東西之前就擋掉掃描式請求",
);
checkTrue(
  "service_role 的資料層在密鑰閘門之後才 import",
  tasksCode.indexOf('await import("@/server/notify")') >
    tasksCode.indexOf('secretMatches(url.searchParams.get("k"), secret)'),
);

// 四件事的順序：排信 → 提醒 → flush → purge。
const iBacklog = notifyHandler.indexOf("runNotifyBacklog(20)");
const iReminders = notifyHandler.indexOf("runSessionReminders()");
const iFlush = notifyHandler.indexOf("flushEmailOutbox(20)");
const iPurge = notifyHandler.indexOf("purgeEmailBodies()");
checkTrue("反空殼：四件事都在", iBacklog > 0 && iReminders > 0 && iFlush > 0 && iPurge > 0);
checkTrue("backlog 在提醒之前", iBacklog < iReminders);
checkTrue(
  "兩個「往 outbox 放東西」的步驟都在 flush 之前",
  iReminders < iFlush,
  "順序顛倒的話，這一輪剛排進來的信要等下一輪（10 分鐘後）才寄得出去",
);
checkTrue("purge 最後", iFlush < iPurge);

// =============================================================================
// [17] email.ts：裸 fetch、沒有 npm 套件、log 不印地址
// =============================================================================
console.log("\n[17] src/server/email.ts");

const emailTs = readFile(join(ROOT, "src/server/email.ts"));
const emailCode = stripTs(emailTs);
checkTrue("反空殼：email.ts 不是空檔", emailTs.length > 1500);
checkTrue("用裸 fetch 打 Resend", /fetch\(RESEND_ENDPOINT/.test(emailCode));
checkTrue("有 AbortSignal 逾時", /AbortSignal\.timeout\(/.test(emailCode));

const pkg = JSON.parse(readFile(join(ROOT, "package.json")) || "{}");
const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
check("沒有裝 resend 套件（同 amego.ts 的決定）", Object.keys(deps).includes("resend"), false);
check("沒有裝 nodemailer", Object.keys(deps).includes("nodemailer"), false);
check(
  "沒有引入 react-query 之類的新相依",
  Object.keys(deps).includes("@tanstack/react-query-next-experimental"),
  false,
);

checkTrue("沒有 key 時回 dry_run，不打外部請求", /return \{ outcome: "dry_run"/.test(emailCode));
checkTrue(
  "沒有 MAIL_FROM 也算 dry run",
  /emailConfigured/.test(emailCode) && /!apiKey \|\| !from/.test(emailCode),
  "Resend 對空的 from 回 422，那會讓每封信燒掉八次重試",
);
checkTrue("永不 throw", !/\bthrow\b/.test(emailCode));

// ⚠️ log 不准出現裸的收件地址。
const logCalls = [...emailCode.matchAll(/console\.\w+\([\s\S]{0,400}?\);/g)].map((m) => m[0]);
checkTrue("反空殼：email.ts 裡確實有 console 呼叫", logCalls.length >= 3);
for (const call of logCalls) {
  check(
    `log 沒有裸的 message.to：${call.slice(0, 44).replace(/\s+/g, " ")}…`,
    /message\.to(?!\))/.test(call.replace(/maskEmail\(message\.to\)/g, "maskEmail(…)")),
    false,
  );
}
check(
  "log 沒有印整封內文",
  /console\.\w+\([^;]*message\.(text|html)[,)]/.test(
    emailCode.replace(/message\.(text|html)\.length/g, "LEN"),
  ),
  false,
  "內文裡有姓名、場次與訂單編號 —— 只印長度",
);

// =============================================================================
// [18] log 紀律：不可以 console.error(..., error)
// =============================================================================
console.log("\n[18] log 紀律（不可以把個資寫進 Vercel 的 log）");

// ⚠️ **新增任何碰 outbox / registrations 的檔案，就要加進這個清單。**
//    漏加一個檔案的後果是那個檔案永遠不被檢查，而且沒有任何人會發現。
const piiSources = [
  ["src/server/notify.ts", notifyTs],
  ["src/server/email.ts", emailTs],
  ["src/server/repos/email-outbox.ts", readFile(join(ROOT, "src/server/repos/email-outbox.ts"))],
  [
    "src/server/repos/event-registrations.ts",
    readFile(join(ROOT, "src/server/repos/event-registrations.ts")),
  ],
];
for (const [name, src] of piiSources) {
  checkTrue(`反空殼：${name} 讀得到`, src.length > 500);
  const calls = stripTs(src).match(/console\.error\([\s\S]{0,400}?\);/g) ?? [];
  const bad = calls
    .map((c) => c.replace(/`[\s\S]*?`/g, "``").replace(/"[^"]*"/g, '""'))
    .filter((c) => /,\s*(error|err)\s*[,)]/.test(c) || /\(\s*(error|err)\s*\)/.test(c));
  check(`${name} 沒有 console.error(..., error) 這種寫法`, bad.length, 0);
  if (bad.length > 0) console.log(red(`      ${bad[0].slice(0, 160)}`));
}
// 反面對照：把偵測器餵一段確定違規的程式碼，它必須抓得到。
for (const [label, sample, expected] of [
  ["console.error(msg, error)", "console.error(`[x] 失敗`, error);", 1],
  ["console.error(error)", "console.error(error);", 1],
  ["安全寫法：只印 code 與 message", "console.error(`[x] ${error.code} ${error.message}`);", 0],
]) {
  const calls = stripTs(sample).match(/console\.error\([\s\S]{0,400}?\);/g) ?? [];
  const hits = calls
    .map((c) => c.replace(/`[\s\S]*?`/g, "``").replace(/"[^"]*"/g, '""'))
    .filter((c) => /,\s*(error|err)\s*[,)]/.test(c) || /\(\s*(error|err)\s*\)/.test(c));
  check(`偵測器對「${label}」的判斷`, hits.length, expected);
}
checkTrue(
  "email-outbox repo 的 log 印的是 code 與 message",
  /\$\{error\.code\} \$\{error\.message\}/.test(
    readFile(join(ROOT, "src/server/repos/email-outbox.ts")),
  ),
);

// =============================================================================
// [19] 排版：直接 import src/lib/email-templates.ts 本人
// =============================================================================
console.log("\n[19] 信件排版（import 產線那一份）");

let tpl = null;
try {
  tpl = await import(pathToFileURL(join(ROOT, "src/lib/email-templates.ts")).href);
  checkTrue("import src/lib/email-templates.ts 成功", true);
} catch (err) {
  fail += 1;
  console.log(red(`  ✗ 無法 import src/lib/email-templates.ts：${String(err).slice(0, 200)}`));
  console.log(red("      需要 Node ≥ 22.18（原生 TypeScript type stripping）。"));
}

if (tpl) {
  // maskEmail：log 用的那一支。
  check("maskEmail 一般情況", tpl.maskEmail("abcdef@example.com"), "ab***@example.com");
  check("maskEmail 單字元帳號", tpl.maskEmail("a@example.com"), "a***@example.com");
  check("maskEmail 不是 email", tpl.maskEmail("nonsense"), "***");
  check("maskEmail 空值", tpl.maskEmail(null), "***");
  check(
    "maskEmail 的星號數量固定（不洩漏長度）",
    tpl.maskEmail("aaaaaaaaaaaaaaaa@x.com").length - tpl.maskEmail("aaaa@x.com").length,
    0,
  );

  // HTML 跳脫：姓名與活動名稱是使用者輸入。
  check("escapeHtml 處理 <", tpl.escapeHtml("<script>"), "&lt;script&gt;");
  check("escapeHtml 處理 &", tpl.escapeHtml("a & b"), "a &amp; b");
  check("escapeHtml 處理引號", tpl.escapeHtml(`"'`), "&quot;&#39;");

  // 佔位變數。
  check(
    "fill 換掉已知變數",
    tpl.fill("訂單 {orderNo} 完成", { orderNo: "IB-1" }),
    "訂單 IB-1 完成",
  );
  check(
    "fill 對未知變數原樣留著",
    tpl.fill("{unknown}", {}),
    "{unknown}",
    "印出 undefined 比留著原樣糟",
  );

  // 時區：一場台北時間晚上 7 點的活動。
  const evening = "2026-09-12T11:00:00Z"; // = 台北 19:00
  const shown = tpl.formatDateTime(evening, "zh");
  checkTrue(
    `台北時區：${evening} → ${shown} 含 19`,
    /19/.test(shown),
    "Vercel 的機器跑在 UTC，用預設時區會變成上午 11 點",
  );
  check("壞掉的日期回原字串", tpl.formatDateTime("not-a-date", "zh"), "not-a-date");

  // 三封信都產得出 subject / text / html，而且都不是空的。
  const session = {
    title: { zh: "場次<A>", en: "S<A>", ja: "S<A>" },
    location: { zh: "書店", en: "Store", ja: "Store" },
    startsAt: evening,
    endsAt: null,
  };
  const ticket = tpl.renderRegistrationTicketEmail(
    { participantName: "王<小明>", seatNo: 1, orderNo: "IB-202600000001", session },
    undefined,
    "zh",
  );
  checkTrue(
    "報名成功信有 subject / text / html",
    Boolean(ticket.subject && ticket.text && ticket.html),
  );
  check("html 把姓名裡的 < 跳脫掉", /王<小明>/.test(ticket.html), false);
  checkTrue("text 裡是原樣的姓名（純文字不需要跳脫）", /王<小明>/.test(ticket.text));
  checkTrue("subject 帶入了場次名稱", ticket.subject.includes("場次<A>"));

  const reminder = tpl.renderSessionReminderEmail(
    { participantName: "王小明", seatNo: 2, orderNo: "IB-202600000001", session },
    undefined,
    "ja",
  );
  checkTrue("提醒信換語言之後主旨不同", reminder.subject !== ticket.subject);

  const paid = tpl.renderOrderPaidEmail(
    {
      orderNo: "IB-202600000001",
      customerName: "王小明",
      total: 1200,
      items: [{ name: { zh: "書", en: "book", ja: "本" }, quantity: 2, subtotal: 1200 }],
      sessions: [session],
    },
    undefined,
    "zh",
  );
  checkTrue("付款成功信有金額", paid.text.includes("NT$1,200"));
  checkTrue("付款成功信有訂單編號", paid.text.includes("IB-202600000001"));
  check(
    "⚠️ 付款成功信不含發票號碼欄位",
    /發票/.test(paid.text),
    false,
    "發票會逾時，等它就等於讓信也不寄（0022 §0.3）",
  );

  // 文案：DB 的值要蓋過內建佔位。
  const custom = tpl.renderRegistrationTicketEmail(
    { participantName: "A", seatNo: 1, orderNo: "IB-1", session },
    { "registration_ticket.subject": { zh: "自訂主旨 {sessionTitle}", en: "x", ja: "x" } },
    "zh",
  );
  checkTrue("DB 文案蓋過內建佔位", custom.subject.startsWith("自訂主旨"));
  checkTrue("內建佔位一眼看得出還沒填", ticket.subject.includes("（待補："));

  // 內建佔位的每一把 key 都要在 0022 的 seed 裡。
  const seedBlock = (exec0022.match(/insert into public\.email_copy[\s\S]*?on conflict/) ?? [
    "",
  ])[0];
  checkTrue("反空殼：切得到 email_copy 的 seed", seedBlock.length > 500);
  const defaultKeys = Object.keys(tpl.DEFAULT_EMAIL_COPY).sort();
  checkTrue(
    "反空殼：DEFAULT_EMAIL_COPY 有內容",
    defaultKeys.length >= 14,
    `${defaultKeys.length} 把`,
  );
  const seedKeys = [...seedBlock.matchAll(/\('(\w+)', '(\w+)',/g)]
    .map((m) => `${m[1]}.${m[2]}`)
    .sort();
  check(
    "DEFAULT_EMAIL_COPY 的 key 與 0022 的 seed 完全一致",
    defaultKeys,
    seedKeys,
    "兩邊不同步的話，沒有那張表的環境會寄出不一樣的信",
  );

  // 三語都要有值 —— 0001 的 is_localized() 要求三個 key 都在。
  for (const [key, value] of Object.entries(tpl.DEFAULT_EMAIL_COPY)) {
    checkTrue(`${key} 三語都非空`, Boolean(value.zh && value.en && value.ja));
  }
}

// email-templates.ts 不可以 import server-only 的東西。
const tplTs = readFile(join(ROOT, "src/lib/email-templates.ts"));
check(
  "email-templates.ts 沒有 import server-only",
  /server-only/.test(stripTs(tplTs)),
  false,
  "有了它這支測試就 import 不起來，驗到的會是一份複本而不是產線那一份",
);
const tplImports = [...stripTs(tplTs).matchAll(/^import\s+(type\s+)?.*from\s+"([^"]+)"/gm)];
checkTrue("反空殼：抓得到 import 行", tplImports.length >= 1);
for (const m of tplImports) {
  checkTrue(
    `email-templates 的 import「${m[2]}」是 type-only`,
    Boolean(m[1]),
    "值 import 會讓 Node 的 type stripping 真的去解析 @/ 路徑",
  );
}

// =============================================================================
// 併發段
// =============================================================================

const PG_URL = process.env.NOTIFY_SELFTEST_PG_URL;

/** 送一句 SQL，一次一條**獨立連線**。**不 throw** —— 併發測試需要拿到誰失敗了。 */
function looksLikeSingleSelect(sql) {
  const t = sql.trim();
  if (!/^select\b/i.test(t)) return false;
  return t.replace(/;\s*$/, "").indexOf(";") === -1;
}

async function q(sql) {
  const single = looksLikeSingleSelect(sql);
  const text = single
    ? `select coalesce(json_agg(t), '[]'::json)::text from (\n${sql.trim().replace(/;\s*$/, "")}\n) t`
    : sql;
  try {
    const { stdout } = await execFileAsync(
      "psql",
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", PG_URL, "-c", text],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    if (!single) return { ok: true, error: null, rows: [] };
    return { ok: true, error: null, rows: JSON.parse(stdout.trim() || "[]") };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message ?? err), rows: [] };
  }
}

async function must(sql) {
  const r = await q(sql);
  if (!r.ok)
    throw new Error(`SQL 失敗：${r.error.slice(0, 400)}\n--- SQL ---\n${sql.slice(0, 600)}`);
  return r.rows;
}

const one = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
const num = (rows, field = "n") => Number(one(rows)?.[field] ?? NaN);

const SLUG_PREFIX = "notifyselftest-";
const KEY_PREFIX = "notifyselftest-";
const MAIL_PREFIX = "notifyselftest:";

/** FK 安全的清理順序。開頭與結尾各跑一次。 */
const CLEANUP_SQL = `
delete from public.email_outbox where dedupe_key like '${MAIL_PREFIX}%';
delete from public.event_registrations r
 where r.order_id in (select o.id from public.orders o where o.idempotency_key like '${KEY_PREFIX}%')
    or r.session_id in (select s.id from public.event_sessions s
                         where s.product_id like '${SLUG_PREFIX}%');
delete from public.order_post_payment_log
 where order_id in (select o.id from public.orders o where o.idempotency_key like '${KEY_PREFIX}%');
delete from public.orders where idempotency_key like '${KEY_PREFIX}%';
delete from public.event_sessions where product_id like '${SLUG_PREFIX}%';
delete from public.products where id like '${SLUG_PREFIX}%';
`;

if (!PG_URL) {
  skipped.push("併發測試（缺 NOTIFY_SELFTEST_PG_URL）");
  console.log(yellow("\n[20–27] 併發測試 —— 跳過：沒有 NOTIFY_SELFTEST_PG_URL"));
  console.log(
    yellow("       設好之後重跑，才會驗到 outbox 冪等、claim 不重複、notify claim 不重跑、"),
  );
  console.log(
    yellow("       退避、放棄重試、purge、on_roster 閘門與 migration 冪等。指令見本檔檔頭。"),
  );
} else {
  try {
    if (process.env.NOTIFY_SELFTEST_APPLY === "1") {
      console.log("\n[20] 套用 0001–0022（NOTIFY_SELFTEST_APPLY=1）");
      // Supabase 特有的東西本機沒有：auth.users / storage.* 是 0001–0003 要的，
      // 三個 role 是每一支 migration 的 grant 要的。建成最小可用的樣子。
      await must(`
        create extension if not exists pgcrypto;
        do $$ begin
          if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
        end $$;
        create schema if not exists auth;
        create table if not exists auth.users (
          id uuid primary key default gen_random_uuid(), email text,
          raw_user_meta_data jsonb, created_at timestamptz not null default now());
        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key, name text, public boolean default false,
          file_size_limit bigint, allowed_mime_types text[], owner uuid,
          created_at timestamptz default now());
        create table if not exists storage.objects (
          id uuid primary key default gen_random_uuid(), bucket_id text, name text,
          owner uuid, metadata jsonb, created_at timestamptz default now());
        alter table storage.objects enable row level security;
        grant usage on schema public to anon, authenticated, service_role;
      `);
      for (const f of migrations) {
        // 0008 要 pg_net + vault + pg_cron，本機沒有。跳過它不影響這一期要驗的任何東西。
        if (f.startsWith("0008_") || f.startsWith("0022_")) continue;
        const r = await q(readFile(join(MIG_DIR, f)));
        if (!r.ok) throw new Error(`套用 ${f} 失敗：${r.error.slice(0, 600)}`);
      }
      checkTrue("0001–0021 套用完成（0008 跳過）", true);

      // ---- 0022 套用**之前**先放一張「歷史已付款訂單」------------------------
      // ⚠️ 這是這一期最危險的失敗模式，值得用一張真的訂單驗：0001–0021 期間沒有
      //    任何東西寫過 notify 列，所以 notify_backlog() 的條件（已付款 + 沒有
      //    notify 列）會把**每一張歷史訂單**都判成「還沒通知」。少了 §10 的回填，
      //    套用 migration 的當下，第一次排程就會寄一封幾個月前的付款成功信給
      //    每一位舊客人 —— 不可撤回、直接寄到真人信箱、而且量很大。
      const HISTORIC = "eeee0000-0000-4000-8000-000000000201";
      await must(`
        delete from public.orders where id = '${HISTORIC}';
        insert into public.orders (id, customer_name, customer_email, customer_phone,
                                   subtotal, total, idempotency_key, payment_status, paid_at)
        values ('${HISTORIC}','自檢舊客人','selftest-historic@example.invalid','0900000000',
                380,380,'${KEY_PREFIX}historic','paid', now() - interval '120 days');
      `);

      const apply = await q(sql0022);
      checkTrue("0022 套用成功", apply.ok);
      if (!apply.ok) throw new Error(`套用 0022 失敗：${apply.error.slice(0, 600)}`);

      console.log("\n[20a] §10 回填：套用當下不會寄信給歷史客人");
      const histLog = one(
        await must(
          `select (completed_at is not null) done, coalesce(error_message,'') why
             from public.order_post_payment_log
            where order_id = '${HISTORIC}' and step = 'notify'`,
        ),
      );
      check("歷史訂單被補上一列 notify log", histLog !== null, true);
      check("那一列是「已完成」（＝這一步關掉了）", histLog?.done, true);
      checkTrue(
        "而且留下了為什麼",
        String(histLog?.why ?? "").includes("skipped_backfill"),
        "只寫 completed_at 等於謊稱寄過了",
      );
      check(
        "🚨 notify_backlog 看不到這張歷史訂單",
        num(
          await must(
            `select count(*)::int n from public.notify_backlog(1000) where order_id='${HISTORIC}'`,
          ),
        ),
        0,
        "看得到就代表套用 migration 之後第一次排程會寄信給每一位歷史客人",
      );
      check(
        "claim 也 claim 不到（already_sent）",
        one(await must(`select reason from public.claim_order_notify('${HISTORIC}')`))?.reason,
        "already_sent",
      );

      // 反面對照：0022 之後才付款的訂單**必須**進得了 backlog，否則上面那個 0
      // 有可能是因為 notify_backlog 整支壞掉。
      const FRESH = "eeee0000-0000-4000-8000-000000000202";
      await must(`
        insert into public.orders (id, customer_name, customer_email, customer_phone,
                                   subtotal, total, idempotency_key, payment_status, paid_at)
        values ('${FRESH}','自檢新客人','selftest-fresh@example.invalid','0900000000',
                380,380,'${KEY_PREFIX}fresh','paid', now());
      `);
      check(
        "反面對照：0022 之後付款的訂單進得了 backlog",
        num(
          await must(
            `select count(*)::int n from public.notify_backlog(1000) where order_id='${FRESH}'`,
          ),
        ),
        1,
      );

      // migration 冪等：再套一次，第二次必須零錯誤，而且回填不會把 FRESH 蓋掉。
      const again = await q(sql0022);
      checkTrue("0022 套第二次零錯誤（冪等）", again.ok);
      if (!again.ok) console.log(red(`      ${again.error.slice(0, 300)}`));
      check(
        "⚠️ 重跑 migration 不會把新訂單也回填成「已完成」",
        num(
          await must(
            `select count(*)::int n from public.notify_backlog(1000) where order_id='${FRESH}'`,
          ),
        ),
        1,
        "on conflict do nothing 只擋重複，但第二次套用時 FRESH 還沒有 notify 列 —— 這一條就是在盯這件事",
      );

      await must(`delete from public.orders where id in ('${HISTORIC}','${FRESH}')`);
    }

    console.log("\n[21] 前置：清理殘骸並建立測試資料");
    await must(CLEANUP_SQL);

    const LOC = `'{"zh":"自檢","en":"selftest","ja":"セルフテスト"}'::jsonb`;
    const PRODUCT = `${SLUG_PREFIX}a`;
    const SESSION = "eeee0000-0000-4000-8000-000000000001";
    const ORDER_PAID = "eeee0000-0000-4000-8000-000000000101";
    const ORDER_PENDING = "eeee0000-0000-4000-8000-000000000102";

    await must(`
      insert into public.products (id, slug, product_type, title, summary, description, price, status)
      values ('${PRODUCT}','${PRODUCT}','event', ${LOC}, ${LOC}, ${LOC}, 500, 'active');

      insert into public.event_sessions (id, product_id, title, location, starts_at, capacity, status)
      values ('${SESSION}','${PRODUCT}', ${LOC}, ${LOC}, now() + interval '20 hours', 20, 'open');

      insert into public.orders (id, customer_name, customer_email, customer_phone,
                                 subtotal, total, idempotency_key, payment_status, paid_at, locale)
      values ('${ORDER_PAID}','自檢','selftest-paid@example.invalid','0900000000',
              1000,1000,'${KEY_PREFIX}paid','paid', now(), 'zh'),
             ('${ORDER_PENDING}','自檢','selftest-pending@example.invalid','0900000000',
              500,500,'${KEY_PREFIX}pending','pending', null, 'zh');

      insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
      values ('${ORDER_PAID}','${PRODUCT}','${SESSION}', ${LOC}, 500, 2, 1000, 'event'),
             ('${ORDER_PENDING}','${PRODUCT}','${SESSION}', ${LOC}, 500, 1, 500, 'event');

      do $$
      declare v_paid bigint; v_pending bigint;
      begin
        select id into v_paid    from public.order_items where order_id = '${ORDER_PAID}';
        select id into v_pending from public.order_items where order_id = '${ORDER_PENDING}';
        perform public.reserve_session_seat('${ORDER_PAID}', v_paid, '${SESSION}', 2,
          '[{"name":"甲","email":"seat1@example.invalid"},{"name":"乙","phone":"0900111222"}]'::jsonb);
        perform public.reserve_session_seat('${ORDER_PENDING}', v_pending, '${SESSION}', 1,
          '[{"name":"丙","email":"seat3@example.invalid"}]'::jsonb);
      end $$;
    `);
    check(
      "前置：3 位報名，其中 2 位在簽到表上",
      [
        num(
          await must(
            `select count(*)::int n from public.admin_event_roster where session_id='${SESSION}'`,
          ),
        ),
        num(
          await must(
            `select count(*)::int n from public.admin_event_roster where session_id='${SESSION}' and on_roster`,
          ),
        ),
      ],
      [3, 2],
    );

    // -------------------------------------------------------------------------
    // [22] outbox 冪等：20 個並行 enqueue 同一 dedupe_key
    // -------------------------------------------------------------------------
    console.log("\n[22] outbox 冪等 —— 20 個並行 enqueue 同一把 dedupe_key");
    const dedupe = `${MAIL_PREFIX}order:${ORDER_PAID}`;
    const enq = await Promise.all(
      Array.from({ length: 20 }, () =>
        q(
          `select public.enqueue_order_email('${ORDER_PAID}','${dedupe}','主旨','text','<p>h</p>') ok`,
        ),
      ),
    );
    check("20 個請求全部沒有出錯", enq.filter((r) => r.ok).length, 20);
    if (enq.some((r) => !r.ok))
      console.log(red(`      ${enq.find((r) => !r.ok).error.slice(0, 300)}`));
    check(
      "email_outbox 恰好 1 列",
      num(
        await must(`select count(*)::int n from public.email_outbox where dedupe_key='${dedupe}'`),
      ),
      1,
    );
    check(
      "恰好 1 個回 true（其餘都是「已經排過了」）",
      enq.filter((r) => r.ok && one(r.rows)?.ok === true).length,
      1,
    );

    // -------------------------------------------------------------------------
    // [23] on_roster 閘門：不在簽到表上的人排不進去
    // -------------------------------------------------------------------------
    console.log("\n[23] on_roster 閘門");
    const allRegs = await must(
      `select registration_id::text id, on_roster from public.admin_event_roster where session_id='${SESSION}' order by seat_no`,
    );
    const itemsJson = allRegs
      .map(
        (r) =>
          `{"registration_id":"${r.id}","dedupe_key":"${MAIL_PREFIX}reg:${r.id}","subject":"s","body_text":"t","body_html":"<p>h</p>"}`,
      )
      .join(",");
    const enqRegsN = num(
      await must(`select public.enqueue_registration_emails('[${itemsJson}]'::jsonb) n`),
      "n",
    );
    check(
      "3 位報名只排進 1 封（另 2 位：一位未付款、一位只留電話）",
      enqRegsN,
      1,
      "on_roster 是 0021 §3 的唯一定義；只留電話是合法的報名（0020）",
    );
    check(
      "排進去的那一封收件人是已付款且有信箱的那一位",
      one(
        await must(
          `select to_email from public.email_outbox where dedupe_key like '${MAIL_PREFIX}reg:%'`,
        ),
      )?.to_email,
      "seat1@example.invalid",
    );
    // 反面對照：把未付款那一位的訂單改成已付款，同一批就排得進去了。
    await must(
      `update public.orders set payment_status='paid', paid_at=now() where id='${ORDER_PENDING}'`,
    );
    const enqAfterPaid = num(
      await must(`select public.enqueue_registration_emails('[${itemsJson}]'::jsonb) n`),
      "n",
    );
    check("反面對照：訂單付款之後就排得進去了", enqAfterPaid, 1);
    await must(
      `update public.orders set payment_status='pending', paid_at=null where id='${ORDER_PENDING}'`,
    );

    // -------------------------------------------------------------------------
    // [24] notify claim 不重跑：兩個並行 claim 同一張訂單
    // -------------------------------------------------------------------------
    console.log("\n[24] notify claim —— 兩個並行 claim 同一張訂單");
    await must(`delete from public.order_post_payment_log where order_id='${ORDER_PAID}'`);
    const claims = await Promise.all([
      q(`select claimed, reason from public.claim_order_notify('${ORDER_PAID}')`),
      q(`select claimed, reason from public.claim_order_notify('${ORDER_PAID}')`),
    ]);
    check("兩個請求都沒有出錯", claims.filter((r) => r.ok).length, 2);
    check(
      "恰好一次 claimed=true",
      claims.filter((r) => r.ok && one(r.rows)?.claimed === true).length,
      1,
    );
    check(
      "輸的那一個 reason 是 locked",
      claims.filter((r) => r.ok && one(r.rows)?.reason === "locked").length,
      1,
    );
    await must(`select public.finish_order_notify('${ORDER_PAID}')`);
    check(
      "結掉之後再 claim 回 already_sent（冪等，不是失敗）",
      one(await must(`select reason from public.claim_order_notify('${ORDER_PAID}')`))?.reason,
      "already_sent",
    );
    check(
      "沒付款的訂單 claim 不到",
      one(await must(`select reason from public.claim_order_notify('${ORDER_PENDING}')`))?.reason,
      "order_not_paid",
    );
    check(
      "notify_backlog 看不到已完成的那一張",
      num(
        await must(
          `select count(*)::int n from public.notify_backlog(100) where order_id='${ORDER_PAID}'`,
        ),
      ),
      0,
    );

    // -------------------------------------------------------------------------
    // [25] claim 不重複：20 列 pending，5 個並行 claim_email_batch(5)
    // -------------------------------------------------------------------------
    console.log("\n[25] claim_email_batch —— 20 列 pending，5 個並行各拿 5 封");
    // ⚠️ claim_email_batch() 是**全表**的 —— 它不知道什麼叫「測試資料」，那正是它
    //    在正式環境該有的行為。所以這一段開始之前要把表上其他 pending 的列推到
    //    未來，否則別人留下的殘骸會混進這一輪的統計（這支測試第一次跑就是這樣：
    //    20 列 pending 卻claim 到 22 個 id）。
    await must(`
      delete from public.email_outbox where dedupe_key like '${MAIL_PREFIX}%';
      update public.email_outbox set next_attempt_at = now() + interval '100 years'
       where status = 'pending' and dedupe_key not like '${MAIL_PREFIX}%';
      insert into public.email_outbox (dedupe_key, to_email, subject, body_text, body_html)
      select '${MAIL_PREFIX}batch:' || gs, 'batch@example.invalid', 's', 't', '<p>h</p>'
        from generate_series(1,20) gs;
    `);
    const batches = await Promise.all(
      Array.from({ length: 5 }, () => q(`select id::text id from public.claim_email_batch(5)`)),
    );
    check("5 個請求全部沒有出錯", batches.filter((r) => r.ok).length, 5);
    if (batches.some((r) => !r.ok))
      console.log(red(`      ${batches.find((r) => !r.ok).error.slice(0, 300)}`));
    const claimedIds = batches.flatMap((r) => (r.ok ? r.rows.map((x) => x.id) : []));
    check(
      "回傳的 id 攤平之後沒有重複",
      claimedIds.length - new Set(claimedIds).size,
      0,
      "重複 = 同一封信被寄兩次",
    );
    checkTrue(`總數 ≤ 20（實際 ${claimedIds.length}）`, claimedIds.length <= 20);
    checkTrue(`總數 > 0（反空殼，實際 ${claimedIds.length}）`, claimedIds.length > 0);
    check(
      "拿到的每一個 id 都是這一輪插進去的那 20 列",
      num(
        await must(
          `select count(*)::int n from public.email_outbox
            where id::text in (${claimedIds.map((i) => `'${i}'`).join(",") || "''"})
              and dedupe_key like '${MAIL_PREFIX}batch:%'`,
        ),
      ),
      claimedIds.length,
    );
    check(
      "被拿走的那幾列 attempts 都變成 1",
      num(
        await must(
          `select count(*)::int n from public.email_outbox
            where dedupe_key like '${MAIL_PREFIX}batch:%' and attempts = 1`,
        ),
      ),
      claimedIds.length,
    );
    check(
      "再 claim 一次只拿得到剩下沒被碰過的那幾列",
      (await must(`select id::text id from public.claim_email_batch(20)`)).length,
      20 - claimedIds.length,
      "被佔住的那些 next_attempt_at 已經被推到未來，拿不到",
    );

    // -------------------------------------------------------------------------
    // [26] 退避與放棄重試
    // -------------------------------------------------------------------------
    console.log("\n[26] 退避 2^n 與第 8 次放棄");
    check(
      "退避表：1→2、3→8、8→256、100→360（大數不溢位）、null→2",
      (
        await must(
          `select public.email_backoff_minutes(1) a, public.email_backoff_minutes(3) b,
                  public.email_backoff_minutes(8) c, public.email_backoff_minutes(100) d,
                  public.email_backoff_minutes(null) e`,
        )
      ).map((r) => [Number(r.a), Number(r.b), Number(r.c), Number(r.d), Number(r.e)])[0],
      [2, 8, 256, 360, 2],
    );
    const backoffKey = `${MAIL_PREFIX}backoff:1`;
    await must(`
      delete from public.email_outbox where dedupe_key = '${backoffKey}';
      insert into public.email_outbox (dedupe_key, to_email, subject, body_text, body_html)
      values ('${backoffKey}', 'backoff@example.invalid', 's', 't', '<p>h</p>');
    `);
    // 失敗三次：每次都要先把 next_attempt_at 撥回現在才 claim 得到。
    for (let i = 0; i < 3; i += 1) {
      await must(
        `update public.email_outbox set next_attempt_at = now() where dedupe_key='${backoffKey}'`,
      );
      await must(
        `select public.fail_email(id, 'selftest failure') from public.claim_email_batch(1)
          where dedupe_key = '${backoffKey}'`,
      );
    }
    const after3 = one(
      await must(
        `select attempts, status,
                extract(epoch from (next_attempt_at - now()))::int secs
           from public.email_outbox where dedupe_key='${backoffKey}'`,
      ),
    );
    check("失敗 3 次之後 attempts = 3", Number(after3?.attempts), 3);
    check("還在 pending（還有重試額度）", after3?.status, "pending");
    checkTrue(
      `退避落在 8 分鐘 ±30 秒（實際 ${after3?.secs} 秒）`,
      Math.abs(Number(after3?.secs) - 480) <= 30,
      "2^3 = 8 分鐘",
    );
    // 再燒五次到第 8 次。
    for (let i = 0; i < 5; i += 1) {
      await must(
        `update public.email_outbox set next_attempt_at = now() where dedupe_key='${backoffKey}'`,
      );
      await must(
        `select public.fail_email(id, 'selftest failure') from public.claim_email_batch(1)
          where dedupe_key = '${backoffKey}'`,
      );
    }
    const after8 = one(
      await must(
        `select attempts, status, last_error from public.email_outbox where dedupe_key='${backoffKey}'`,
      ),
    );
    check("第 8 次之後 attempts = 8", Number(after8?.attempts), 8);
    check("第 8 次之後 status = failed（後台看得到「有 N 封寄不出去」）", after8?.status, "failed");
    checkTrue("失敗原因留著", Boolean(after8?.last_error));
    check(
      "failed 的列不會再被 claim 到",
      (
        await must(
          `select id::text id from public.claim_email_batch(50)
            where dedupe_key = '${backoffKey}'`,
        )
      ).length,
      0,
    );

    // -------------------------------------------------------------------------
    // [27] purge：清內文，保留憑據
    // -------------------------------------------------------------------------
    console.log("\n[27] purge_sent_email_bodies");
    const purgeKey = `${MAIL_PREFIX}purge:1`;
    const freshKey = `${MAIL_PREFIX}purge:2`;
    await must(`
      delete from public.email_outbox where dedupe_key in ('${purgeKey}','${freshKey}');
      insert into public.email_outbox
        (dedupe_key, to_email, subject, body_text, body_html, status, sent_at, provider_id)
      values ('${purgeKey}', 'old@example.invalid', '舊主旨', '舊內文', '<p>舊</p>',
              'sent', now() - interval '31 days', 'prov-1'),
             ('${freshKey}', 'new@example.invalid', '新主旨', '新內文', '<p>新</p>',
              'sent', now() - interval '2 days', 'prov-2');
    `);
    check("purge 清了 1 列", num(await must(`select public.purge_sent_email_bodies() n`), "n"), 1);
    const purged = one(
      await must(
        `select body_text, body_html, subject, dedupe_key, to_email, provider_id,
                (sent_at is not null) has_sent_at, (body_purged_at is not null) purged
           from public.email_outbox where dedupe_key='${purgeKey}'`,
      ),
    );
    check("body_text 清空", purged?.body_text, "");
    check("body_html 清空", purged?.body_html, "");
    check("subject 還在", purged?.subject, "舊主旨");
    check("dedupe_key 還在", purged?.dedupe_key, purgeKey);
    check("sent_at 還在", purged?.has_sent_at, true);
    check("to_email 還在（客訴時要回答「寄到哪裡」）", purged?.to_email, "old@example.invalid");
    check("provider_id 還在", purged?.provider_id, "prov-1");
    check("body_purged_at 標上了", purged?.purged, true);
    check(
      "兩天前寄的那一封沒有被動到",
      one(await must(`select body_text from public.email_outbox where dedupe_key='${freshKey}'`))
        ?.body_text,
      "新內文",
    );
    check(
      "再跑一次清 0 列（冪等）",
      num(await must(`select public.purge_sent_email_bodies() n`), "n"),
      0,
    );

    // -------------------------------------------------------------------------
    // [28] 提醒信要掃哪幾場
    // -------------------------------------------------------------------------
    console.log("\n[28] sessions_due_for_reminder");
    check(
      "20 小時後開始的那一場在清單裡",
      num(
        await must(
          `select count(*)::int n from public.sessions_due_for_reminder() where session_id='${SESSION}'`,
        ),
      ),
      1,
    );
    await must(`update public.event_sessions set status='closed' where id='${SESSION}'`);
    check(
      "關掉的場次不發提醒",
      num(
        await must(
          `select count(*)::int n from public.sessions_due_for_reminder() where session_id='${SESSION}'`,
        ),
      ),
      0,
    );
    await must(`update public.event_sessions set status='open' where id='${SESSION}'`);
    await must(
      `update public.event_sessions set starts_at = now() + interval '5 days' where id='${SESSION}'`,
    );
    check(
      "五天後的場次還不用提醒",
      num(
        await must(
          `select count(*)::int n from public.sessions_due_for_reminder() where session_id='${SESSION}'`,
        ),
      ),
      0,
    );
    check(
      "已經開始的場次不再提醒",
      num(
        await must(
          `select count(*)::int n from public.sessions_due_for_reminder(interval '10 days')
             where session_id='${SESSION}' and starts_at < now()`,
        ),
      ),
      0,
    );

    // -------------------------------------------------------------------------
    // [29] 收尾：清乾淨
    // -------------------------------------------------------------------------
    console.log("\n[29] 清理");
    const cleanup = await q(CLEANUP_SQL);
    checkTrue("清理成功", cleanup.ok);
    check(
      "沒有殘留的 email_outbox 列",
      num(
        await must(
          `select count(*)::int n from public.email_outbox where dedupe_key like '${MAIL_PREFIX}%'`,
        ),
      ),
      0,
    );
    check(
      "沒有殘留的訂單",
      num(
        await must(
          `select count(*)::int n from public.orders where idempotency_key like '${KEY_PREFIX}%'`,
        ),
      ),
      0,
    );
  } catch (err) {
    fail += 1;
    console.log(red(`\n  ✗ 併發段中斷：${String(err.message ?? err).slice(0, 600)}`));
  }
}

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------

console.log(`\n${"─".repeat(52)}`);
if (skipped.length > 0) {
  console.log(yellow(`略過 ${skipped.length} 段：`));
  for (const s of skipped) console.log(yellow(`  • ${s}`));
}
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
