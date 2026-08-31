#!/usr/bin/env node
/**
 * event-registration-selftest.mjs —— 場次名額與逐位參加者（0020）的自檢
 *
 * 分兩段，理由與 inventory-stock-selftest 相同：這支測試在沒有資料庫的機器上也
 * 必須有意義。
 *
 *   [靜態] 讀 supabase/migrations/0020 與幾支 .ts 的原始碼，守的是**設計不變量**：
 *          reserve_session_seat 的七步在不在、expire_unpaid_orders 的
 *          RETURNS TABLE 有沒有被改形狀、event_registrations 是不是零 grant、
 *          碰 registrations 的 console.error 有沒有印整包 error。這些答案就寫在
 *          檔案裡，不連線也回答得出來。**永遠會跑。**
 *
 *   [併發] 對一個真的資料庫**同時發請求**。每一次 q() 都是一個獨立的 psql
 *          子行程，也就是一條獨立的連線與一個獨立的交易，所以 Promise.all 出來
 *          的是真正的併發，不是同一條連線上的多個 statement。
 *
 * ── 為什麼併發段跑本機 PostgreSQL，不是 Management API ──────────────────
 * 既有的幾支自檢用 SUPABASE_ACCESS_TOKEN 打 Management API 的 /database/query。
 * 這台機器上**沒有那個 token**，而併發正是這一期最需要驗的部分 —— 超賣、原子性、
 * 回滾冪等、死鎖，四條都只有真的同時發請求才驗得到。所以這一支改成打本機
 * PostgreSQL：`psql` 每呼叫一次就是一條新連線，這一點與 Management API 一樣，
 * 而且不需要任何憑證，也不會碰到正式庫。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 EVENT_SELFTEST_PG_URL，而那個變數要
 *    自己設；沒設就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * 準備一個可以跑的本機庫（PostgreSQL 14+ 即可，實測 18.3）：
 *
 *     createdb ib_p1_test
 *     EVENT_SELFTEST_PG_URL=postgres:///ib_p1_test \
 *     EVENT_SELFTEST_APPLY=1 node scripts/event-registration-selftest.mjs
 *
 * `EVENT_SELFTEST_APPLY=1` 會先把 0001–0020 套上去（0008 需要 pg_net / vault /
 * pg_cron，本機沒有，會被跳過；0020 自己的排程那一段有 to_regproc 判斷，缺
 * pg_cron 只會印 warning）。套過一次之後就不用再帶這個變數。
 *
 * 環境變數：
 *   EVENT_SELFTEST_PG_URL   本機測試庫的連線字串（併發段的開關）
 *   EVENT_SELFTEST_APPLY    設成 1 時先套用 0001–0020
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/event-registration-selftest.mjs";

const MIG_0020 = join(ROOT, "supabase/migrations/0020_event_sessions_registrations.sql");
const MIG_0011 = join(ROOT, "supabase/migrations/0011_inventory_single_source.sql");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 inventory-stock-selftest 同一套）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

const readFile = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** 把 `--` 註解整行拿掉，免得註解裡提到的字串讓 includes() 假性通過。 */
function stripComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/**
 * 拿掉 TypeScript 的註解（`//` 與 `/* … *\/`）。
 *
 * ⚠️ 沒有這一步，底下每一條「不可以出現 X」的斷言都會被**註解裡提到 X** 弄成假性
 *    失敗 —— 而這支測試第一次跑就是這樣紅了四條。這個 repo 的檔頭又特別長，所以
 *    「程式碼裡有沒有」與「檔案裡有沒有」在這裡差很多。
 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** 切出單一函式的本體：從宣告切到它自己的 comment on（同 inventory-stock 的手法）。 */
function functionBody(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  if (start === -1) return "";
  const end = sql.indexOf(`comment on function ${signature}`, start);
  return sql.slice(start, end === -1 ? sql.length : end);
}

// =============================================================================
// [1] migration 檔案盤點
// =============================================================================
console.log("\n[1] migration 檔案盤點");
check("0020 存在", existsSync(MIG_0020), true);
// 這一期不准動到既有的 0001–0019，所以它們也必須都還在。
const migrations = existsSync(join(ROOT, "supabase/migrations"))
  ? readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
  : [];
// 0021（名單的遮罩 view、明文揭露與 CSV 匯出）加進來時，這幾條會把人叫回來。
// 逐條重讀過：0021 **不動** 0020 的任何一張表、任何一支函式，它只是在
// event_registrations 上面加一個遮罩過的 view 與兩支會留痕的 security definer
// 函式。所以下面每一條 0020 的斷言原樣成立。0021 自己的內容由
// scripts/roster-csv-selftest.mjs 驗。
//
// 0022（交易信 outbox 與付款通知）第二次把人叫回來。逐條重讀過：它**只讀**
// 0020 建的東西 —— enqueue_registration_emails() join public.event_registrations
// 取信箱、sessions_due_for_reminder() 讀 public.event_sessions。它沒有重新定義
// reserve_session_seat / release_session_seat / expire_unpaid_orders 任何一支
// （notify-selftest [2] 逐支 grep 守著），也沒有動 order_items.session_id 或
// 那兩張表的 grant。**「佔了 N 個位子」與「有 N 位參加者」是同一句 SQL 的兩個
// 面向**這個不變量因此原封不動：0022 一行 insert / delete 都沒有打在
// event_registrations 上，它只把地址讀出來寫進 email_outbox。
// 所以下面每一條 0020 的斷言原樣成立。0022 自己的內容由 notify-selftest 驗。
// 0024_blackcat_payment.sql（黑貓 PAY 線上刷卡：orders.payment_url /
// payments.gateway_trans_id / payment_alerts()）是這一期加的。
// 0025_event_speaker.sql（活動掛講者：public.events.speaker_id -> public.artists.id）
// 是這一期加的。它只在 public.events 上加一欄與一個索引，沒有碰
// event_sessions / event_registrations / order_items 任何一張表或任何一支函式，
// 所以下面每一條 0020 的斷言原樣成立。0025 自己的內容由 artists-selftest 驗。
check("migrations 共 25 支", migrations.length, 25);
check("0020 仍在原位", migrations[19], "0020_event_sessions_registrations.sql");
check("0021 仍在原位", migrations[20], "0021_roster_pii.sql");
check("0023 仍在原位", migrations[22], "0023_fix_cron_guard.sql");
check("0024 仍在原位", migrations[23], "0024_blackcat_payment.sql");
check("編號連續且 0025 是最後一支", migrations[24], "0025_event_speaker.sql");
for (const f of [
  "0004_commerce_products.sql",
  "0006_order_expiry.sql",
  "0011_inventory_single_source.sql",
  "0019_vendors_pii_portal.sql",
]) {
  check(`${f} 仍在`, migrations.includes(f), true);
}

const sql0020 = readFile(MIG_0020);
const sql0011 = readFile(MIG_0011);
const exec0020 = stripComments(sql0020);
const exec0011 = stripComments(sql0011);

// 反空殼：先證明檔案真的有內容，否則下面每一條 includes() 都是假性結果。
checkTrue("0020 不是空檔（> 8000 字）", exec0020.length > 8000);

// =============================================================================
// [2] 名額搬家：products 那兩欄被綁死，event_sessions 才是真相
// =============================================================================
console.log("\n[2] 名額搬到 event_sessions");
checkTrue(
  "建了 event_sessions",
  exec0020.includes("create table if not exists public.event_sessions"),
);
checkTrue(
  "建了 event_registrations",
  exec0020.includes("create table if not exists public.event_registrations"),
);
checkTrue(
  "products 的兩條舊 CHECK 被拆掉",
  exec0020.includes("drop constraint if exists products_capacity_shape") &&
    exec0020.includes("drop constraint if exists products_seats_within_capacity"),
);
checkTrue(
  "新 CHECK 強制 capacity is null and seats_taken = 0",
  /add constraint products_capacity_moved_to_sessions\s+check \(capacity is null and seats_taken = 0\)/.test(
    exec0020,
  ),
);
// 欄位保留不 drop —— 三個寫死 capacity, seats_taken 的 COLUMNS 字串還在跑。
check(
  "0020 沒有 drop 掉 products 的任何欄位",
  /alter table public\.products[\s\S]{0,80}drop column/i.test(exec0020),
  false,
);
// ⚠️ 這一期刻意不加 seats_offered（候補是 Phase 4）。欄位要跟讀它的程式碼同一期出。
check("沒有提早加入 seats_offered", exec0020.includes("seats_offered"), false);
checkTrue(
  "event_sessions 沒有 'full' 狀態（推導得出來的東西不存）",
  /check \(status in \('open', 'closed'\)\)/.test(exec0020),
);

// =============================================================================
// [3] reserve_session_seat 的七步
// =============================================================================
console.log("\n[3] reserve_session_seat 的七步");
const reserveBody = functionBody(exec0020, "public.reserve_session_seat");
checkTrue("切得出 reserve 的函式本體", reserveBody.length > 800);
checkTrue("① 參加者筆數比對", reserveBody.includes("PARTICIPANT_COUNT_MISMATCH"));
// ⚠️ 鎖模式必須是 for no key update，不是 for update —— order_items 的外鍵會取
//    FOR KEY SHARE，升級成 FOR UPDATE 就是死鎖。這一條有實測數字支撐（0020 §2）。
checkTrue(
  "② 鎖場次（for no key update）",
  /from public\.event_sessions s[\s\S]{0,300}for no key update/.test(reserveBody),
);
check(
  "② 沒有殘留的 for update（會與外鍵的 KEY SHARE 死鎖）",
  /\bfor update\b/.test(reserveBody),
  false,
);
checkTrue(
  "② 先把整張訂單的場次依 id 排序鎖起來（呼叫端不必記得排序）",
  /where oi\.order_id = p_order_id[\s\S]{0,200}order by s\.id\s+for no key update/.test(
    reserveBody,
  ),
);
check(
  "release 也用 for no key update",
  /\bfor update\b/.test(functionBody(exec0020, "public.release_session_seat")),
  false,
);
check(
  "expire 的 4c 也用 for no key update",
  /from public\.event_sessions s[\s\S]{0,300}for update;/.test(
    functionBody(exec0020, "public.expire_unpaid_orders"),
  ),
  false,
);
checkTrue("③ 跨商品竄改的門", reserveBody.includes("SESSION_PRODUCT_MISMATCH"));
checkTrue("③ order_item 必須屬於這張訂單", reserveBody.includes("ORDER_ITEM_ORDER_MISMATCH"));
checkTrue("④ 場次要 open", reserveBody.includes("SESSION_NOT_OPEN"));
checkTrue("⑤ 沿用既有的 NO_SEATS_LEFT 字串", reserveBody.includes("NO_SEATS_LEFT"));
checkTrue(
  "⑥ 相對更新（+= q），不是寫回讀到的值",
  /set seats_taken = seats_taken \+ p_quantity/.test(reserveBody),
);
checkTrue(
  "⑦ 用 with ordinality 寫參加者",
  /jsonb_array_elements\(p_participants\) with ordinality/.test(reserveBody),
);
// 順序不可以顛倒：①（不寫任何東西）必須在 ⑥（第一次寫入）之前。
checkTrue(
  "① 在 ⑥ 之前（數量不符時完全不寫入）",
  reserveBody.indexOf("PARTICIPANT_COUNT_MISMATCH") <
    reserveBody.indexOf("set seats_taken = seats_taken + p_quantity"),
);
// ③ 必須在 ⑥ 之前，否則竄改的請求會先佔到位子。
checkTrue(
  "③ 在 ⑥ 之前（竄改時 seats_taken 不變）",
  reserveBody.indexOf("SESSION_PRODUCT_MISMATCH") <
    reserveBody.indexOf("set seats_taken = seats_taken + p_quantity"),
);

console.log("\n[4] release_session_seat 的冪等與不 throw");
const releaseBody = functionBody(exec0020, "public.release_session_seat");
checkTrue("切得出 release 的函式本體", releaseBody.length > 400);
checkTrue(
  "用 DELETE…RETURNING 當冪等 claim",
  /delete from public\.event_registrations r[\s\S]{0,200}returning/.test(releaseBody),
);
checkTrue(
  "有 exception when others（絕不 throw）",
  /exception\s+when others then/.test(releaseBody),
);
checkTrue(
  "null 參數回 0 而不是 raise",
  /if p_order_item_id is null then\s+return 0;/.test(releaseBody),
);
check("release 一句 raise 都沒有", (releaseBody.match(/raise exception/gi) ?? []).length, 0);
checkTrue("扣回去用 greatest(0, …)", /greatest\(0, s\.seats_taken - v_freed\)/.test(releaseBody));

// =============================================================================
// [5] expire_unpaid_orders 的 RETURNS TABLE 形狀逐字不變
// =============================================================================
// ⚠️ 這是整支 migration 最容易踩爆的一條。create or replace 改不了 RETURNS TABLE
//    的形狀，要改就得先 drop function —— 而 drop 會斷掉正在跑的 pg_cron job，
//    在 drop 與 create 之間的每一次觸發都會失敗。所以這裡把 0011 與 0020 的那個
//    區塊各自抽出來、正規化空白之後**比對相等**，而不是只 grep 其中一個欄位名。
console.log("\n[5] expire_unpaid_orders 的回傳形狀");

function returnsTableBlock(sql) {
  const i = sql.indexOf("create or replace function public.expire_unpaid_orders");
  if (i === -1) return "";
  const start = sql.indexOf("returns table", i);
  const end = sql.indexOf(")", sql.indexOf("restored_seats", start));
  if (start === -1 || end === -1) return "";
  return sql
    .slice(start, end + 1)
    .replace(/\s+/g, " ")
    .trim();
}

const shape0011 = returnsTableBlock(exec0011);
const shape0020 = returnsTableBlock(exec0020);
checkTrue("抽得出 0011 的 returns table 區塊", shape0011.length > 60);
checkTrue("抽得出 0020 的 returns table 區塊", shape0020.length > 60);
check("0020 的回傳形狀與 0011 逐字相同", shape0020, shape0011);
checkTrue(
  "四個欄位名都在",
  ["expired_id", "expired_order_no", "restored_stock", "restored_seats"].every((c) =>
    shape0020.includes(c),
  ),
);
// 反面對照：如果抽取函式壞了、兩邊都回空字串，上面那條會假性通過。
checkTrue("反空殼：形狀字串不是空的", shape0020 !== "");
const expireBody0020 = functionBody(exec0020, "public.expire_unpaid_orders");
checkTrue("expire 新增了第 4c 步（放掉場次名額）", expireBody0020.includes("event_registrations"));
checkTrue(
  "4c 的刪除與扣回是同一句（data-modifying CTE）",
  /with freed as \([\s\S]{0,300}returning r\.session_id[\s\S]{0,300}update public\.event_sessions/.test(
    expireBody0020,
  ),
);
checkTrue(
  "0011 的 4b 保留列刪除還在",
  expireBody0020.includes("delete from public.stock_reservations"),
);

// =============================================================================
// [6] product_availability 的活動分支改讀場次（漏了會 fail-open）
// =============================================================================
console.log("\n[6] product_availability");
const availView = exec0020.slice(
  exec0020.indexOf("create or replace view public.product_availability"),
);
checkTrue("view 被覆寫", availView.length > 500);
checkTrue(
  "活動分支讀 event_sessions",
  /when p\.product_type in \('event', 'journey'\) then[\s\S]{0,300}from public\.event_sessions s/.test(
    availView,
  ),
);
// 舊寫法是 `and p.capacity is not null` —— 0020 之後那個條件永遠是 false，
// 活動會掉到最後的 else 10（「還很多」）。這一條就是守著那個 fail-open。
check(
  "活動分支沒有殘留 p.capacity is not null 的條件",
  /product_type in \('event', 'journey'\) and p\.capacity is not null/.test(availView),
  false,
);
checkTrue("沒有開放場次時回 0（fail-closed）", /coalesce\(\([\s\S]{0,300}\), 0\)/.test(availView));
checkTrue("只看 open 的場次", /and s\.status = 'open'/.test(availView));
checkTrue("上限仍是 10", /least\(v\.units, 10\)/.test(exec0020));

// =============================================================================
// [7] RLS 與權限
// =============================================================================
console.log("\n[7] RLS 與權限");
check(
  "兩張新表都 enable row level security",
  (exec0020.match(/enable row level security/gi) ?? []).length,
  2,
);
// event_registrations 是 PII：零 policy、零 grant。
checkTrue(
  "event_registrations revoke anon/authenticated",
  exec0020.includes("revoke all on table public.event_registrations from anon, authenticated"),
);
checkTrue(
  "event_registrations 只 grant service_role",
  exec0020.includes("grant all  on table public.event_registrations to service_role"),
);
check(
  "event_registrations 一條 policy 都沒有",
  /create policy \w*event_registrations/i.test(exec0020),
  false,
);
// event_sessions 是公開資訊（名額本來就 anon 讀得到），所以它有一條 policy。
check(
  "0020 只建了一條 policy（event_sessions）",
  (exec0020.match(/create policy/gi) ?? []).length,
  1,
);
checkTrue(
  "event_sessions 的 policy 只放行 open 的場次",
  /create policy event_sessions_select_public[\s\S]{0,400}status = 'open'/.test(exec0020),
);
checkTrue(
  "而且商品必須是 active（草稿商品的場次不外流）",
  /event_sessions_select_public[\s\S]{0,400}p\.status = 'active'/.test(exec0020),
);
// 兩支 security definer 函式都要先 revoke 再 grant。
checkTrue(
  "兩支新函式都列進 revoke/grant 迴圈",
  exec0020.includes("public.reserve_session_seat(uuid, bigint, uuid, integer, jsonb)") &&
    exec0020.includes("public.release_session_seat(bigint)"),
);
checkTrue(
  "revoke ... from public 這一句在",
  exec0020.includes("revoke execute on function %s from public"),
);
checkTrue(
  "grant 給 service_role",
  exec0020.includes("grant  execute on function %s to service_role"),
);
checkTrue(
  "覆寫掉的 expire 也重新 grant 一次",
  exec0020.includes(
    "grant  execute on function public.expire_unpaid_orders(interval, integer) to service_role",
  ),
);
check(
  "兩支函式都是 security definer",
  (functionBody(exec0020, "public.reserve_session_seat").includes("security definer") ? 1 : 0) +
    (functionBody(exec0020, "public.release_session_seat").includes("security definer") ? 1 : 0),
  2,
);

// =============================================================================
// [8] order_items.session_id 的形狀 CHECK
// =============================================================================
console.log("\n[8] order_items.session_id");
checkTrue(
  "加了欄位",
  /alter table public\.order_items\s+add column if not exists session_id uuid/.test(exec0020),
);
checkTrue(
  "外鍵是 on delete restrict",
  /references public\.event_sessions \(id\) on delete restrict/.test(exec0020),
);
checkTrue(
  "CHECK 兩個方向都管",
  /order_items_session_shape check \([\s\S]{0,200}product_type in \('event', 'journey'\) and session_id is not null[\s\S]{0,200}product_type in \('goods', 'book'\) and session_id is null/.test(
    exec0020,
  ),
);
// 沒有 trigger —— order_items 本來就有 denormalized 的 product_type，CHECK 就夠。
check("沒有為此加 trigger", /create trigger \w*order_items\w*session/i.test(exec0020), false);

// =============================================================================
// [9] 回填
// =============================================================================
console.log("\n[9] 回填");
checkTrue(
  "為每個 event/journey 商品建場次",
  /insert into public\.event_sessions[\s\S]{0,600}from public\.products p[\s\S]{0,200}product_type in \('event', 'journey'\)/.test(
    exec0020,
  ),
);
checkTrue(
  "回填的場次是 closed（fail-closed）",
  /'closed',\s*\n\s*0\s*\n\s*from public\.products p/.test(exec0020),
);
checkTrue(
  "可重跑：用 not exists 擋",
  /not exists \(select 1 from public\.event_sessions s where s\.product_id = p\.id\)/.test(
    exec0020,
  ),
);
checkTrue(
  "既有 order_items 指向場次",
  /update public\.order_items oi\s+set session_id =/.test(exec0020),
);
checkTrue(
  "既有訂單補第一位參加者",
  /insert into public\.event_registrations[\s\S]{0,600}o\.customer_name/.test(exec0020),
);
checkTrue(
  "最後把 products 的名額清空",
  /update public\.products\s+set capacity = null,\s+seats_taken = 0/.test(exec0020),
);

// =============================================================================
// [10] 排程：把手動下的 expire-unpaid-orders 補進 repo
// =============================================================================
console.log("\n[10] cron 排程");
checkTrue("0020 補上了 expire-unpaid-orders", exec0020.includes("'expire-unpaid-orders'"));
checkTrue("排程是 */5（與 0008 的 3-53/10 永不同 tick）", exec0020.includes("'*/5 * * * *'"));
checkTrue(
  "缺 pg_cron 時 raise warning 而不是安靜跳過",
  /to_regproc\('cron\.schedule[\s\S]{0,300}raise warning 'PG_CRON_NOT_INSTALLED/.test(exec0020),
);
checkTrue(
  "排程在 commit 之後（cron.schedule 會自己開交易）",
  exec0020.lastIndexOf("commit;") < exec0020.indexOf("'expire-unpaid-orders'"),
);

// =============================================================================
// [11] TypeScript 那一側的設計不變量
// =============================================================================
console.log("\n[11] 程式碼的不變量");

const ordersTs = readFile(join(ROOT, "src/server/repos/orders.ts"));
const cartTs = readFile(join(ROOT, "src/lib/cart.ts"));
const shopTs = readFile(join(ROOT, "src/lib/shop.ts"));
const checkoutTs = readFile(join(ROOT, "src/lib/checkout.ts"));
const regRepoTs = readFile(join(ROOT, "src/server/repos/event-registrations.ts"));
const sessionRepoTs = readFile(join(ROOT, "src/server/repos/event-sessions.ts"));
const regFnTs = readFile(join(ROOT, "src/lib/admin/fns/event-registrations.ts"));
const sessionFnTs = readFile(join(ROOT, "src/lib/admin/fns/event-sessions.ts"));
const productsRepoTs = readFile(join(ROOT, "src/server/repos/products.ts"));
const productsRouteTs = readFile(join(ROOT, "src/routes/admin/_shell.products.tsx"));

checkTrue("反空殼：orders.ts 讀得到", ordersTs.length > 5000);
checkTrue("反空殼：cart.ts 讀得到", cartTs.length > 3000);
checkTrue("反空殼：兩支新 repo 都存在", regRepoTs.length > 1000 && sessionRepoTs.length > 1000);
checkTrue("反空殼：兩支新 fn 都存在", regFnTs.length > 500 && sessionFnTs.length > 500);

// --- 購物車的 line key -------------------------------------------------------
checkTrue("cart.ts 匯出 cartLineKey", /export function cartLineKey\(/.test(cartTs));
checkTrue(
  "line key 是 productId:sessionId",
  /return `\$\{productId\}:\$\{sessionId \?\? ""\}`/.test(cartTs),
);
checkTrue("STORAGE_VERSION 升到 2", /const STORAGE_VERSION = 2;/.test(cartTs));
checkTrue(
  "舊版 localStorage 直接丟棄（不 merge）",
  /version === STORAGE_VERSION \? \(persisted as \{ items: CartLine\[\] \}\) : \{ items: \[\] \}/.test(
    cartTs,
  ),
);
// ⚠️ 參加者不可以進購物車 —— persist() 會把它寫進 localStorage。
check(
  "CartLine 沒有 participants 欄位",
  /participants/.test(cartTs.split("export type CartResult")[0] ?? ""),
  false,
);
// 三個會改購物車的地方都必須用 key，不可以再用 productId。
for (const [file, src] of [["src/routes/cart.tsx", readFile(join(ROOT, "src/routes/cart.tsx"))]]) {
  checkTrue(
    `${file} 用 keyOfLine 而不是 productId`,
    /setQty\(keyOfLine\(line\)/.test(src) && /removeItem\(keyOfLine\(line\)\)/.test(src),
  );
  check(`${file} 沒有殘留 setQty(line.productId`, /setQty\(line\.productId/.test(src), false);
}

// --- shop.ts ----------------------------------------------------------------
checkTrue("shop.ts 匯出 remainingForSession", /export function remainingForSession\(/.test(shopTs));
// remainingFor 對 event/journey 不可以再讀 p.capacity —— 0020 之後那是 null。
const remainingForBody = shopTs.slice(
  shopTs.indexOf("export function remainingFor(p: ShopProduct)"),
  shopTs.indexOf("export function isSoldOut"),
);
checkTrue("反空殼：切得出 remainingFor", remainingForBody.length > 100);
check("remainingFor 不再讀 p.capacity", /p\.capacity/.test(remainingForBody), false);
check("remainingFor 不再讀 p.seatsTaken", /p\.seatsTaken/.test(remainingForBody), false);
checkTrue("remainingFor 改讀 sessions", /p\.sessions/.test(remainingForBody));
checkTrue(
  "沒有場次時回 0（fail-closed，不是 null）",
  /if \(p\.sessions\.length === 0\) return 0;/.test(remainingForBody),
);

// --- orders.ts step 5 --------------------------------------------------------
checkTrue("step 5 改呼叫 reserve_session_seat", /rpc\("reserve_session_seat"/.test(ordersTs));
check(
  "step 5 不再呼叫 reserve_product_seat",
  /reserve_product_seat/.test(stripTs(ordersTs)),
  false,
);
checkTrue("回滾改呼叫 release_session_seat", /rpc\("release_session_seat"/.test(ordersTs));
checkTrue(
  "依 sessionId 排序取鎖（同一商品的兩個梯次是兩列）",
  /sort\(\(a, b\) => \(\(a\.sessionId \?\? ""\) < \(b\.sessionId \?\? ""\) \? -1 : 1\)\)/.test(
    ordersTs,
  ),
);
// ⚠️ 批次 insert 的每一列 key 必須一致（PostgREST 的 "All object keys must match"），
//    但**整批一起有或整批一起沒有** —— 因為 0020 還沒套用時 order_items 根本沒有
//    session_id 這一欄，無條件送就會讓每一筆賣書的訂單收到 400。實測確認過：
//    `column "session_id" of relation "order_items" does not exist`。
checkTrue(
  "session_id 是整批一起決定（anySession）",
  /const anySession = lines\.some\(\(l\) => l\.sessionId !== null\);/.test(ordersTs),
);
checkTrue(
  "有 booking 時每一列都帶 session_id（含書，值是 null）",
  /if \(anySession\) row\.session_id = l\.sessionId;/.test(ordersTs),
);
checkTrue(
  "沒有 booking 時連 select 都不要那一欄",
  /\.select\(anySession \? "id, product_id, session_id" : "id, product_id"\)/.test(ordersTs),
);
// catch 的順序：release 一定在 delete 之前。
const catchIdx = ordersTs.indexOf("await releaseInventoryReservations(reservedInventory");
const releaseIdx = ordersTs.indexOf("await releaseSeats(reservedItemIds)");
const deleteIdx = ordersTs.indexOf("await deleteOrder(order.id)", catchIdx);
checkTrue("反空殼：三個呼叫都找得到", catchIdx > 0 && releaseIdx > 0 && deleteIdx > 0);
checkTrue("releaseSeats 在 deleteOrder 之前", releaseIdx < deleteIdx);
// 名額的前置檢查必須讀場次，不是 products.capacity。
checkTrue(
  "下單前的名額預檢讀場次",
  /session\.seats_taken \+ line\.quantity > session\.capacity/.test(ordersTs),
);
check("預檢不再讀 p.seats_taken", /p\.seats_taken \+ line\.quantity/.test(ordersTs), false);

// --- 場次選擇器抽成共用元件 ---------------------------------------------------
//
// /shop/$slug 的場次選擇器搬到了 src/components/shop/SessionPicker.tsx，因為之後的
// 活動詳情頁要用同一個。抽元件最典型的失敗不是「抽壞了」，是**抽完忘了刪**：兩份
// 一模一樣的 JSX 各自被改一次，然後商品頁與活動頁對同一場活動顯示不同的剩餘名額。
// 所以這裡守的是「只有一份」，不只是「新的那一份存在」。
//
// ⚠️ 全部走 stripTs()。這個 repo 的檔頭與行內註解都很長，而路由檔裡就有一行註解
//    寫著「場次選擇器自己的三句文案（選擇場次／已額滿／…）」—— 不 strip 的話，
//    下面每一條「不可以出現 X」都會被那行註解餵飽。
const slugRouteTsx = readFile(join(ROOT, "src/routes/shop.$slug.tsx"));
const pickerTsx = readFile(join(ROOT, "src/components/shop/SessionPicker.tsx"));
const shopLabelsTs = readFile(join(ROOT, "src/components/shop/labels.ts"));
const slugRouteCode = stripTs(slugRouteTsx);
const pickerCode = stripTs(pickerTsx);

checkTrue("反空殼：shop.$slug.tsx 讀得到", slugRouteCode.length > 3000);
checkTrue("反空殼：SessionPicker.tsx 讀得到", pickerCode.length > 800);

// 路由確實換上了元件。
checkTrue(
  "shop.$slug.tsx import 了 SessionPicker",
  /import \{ SessionPicker \} from "@\/components\/shop\/SessionPicker";/.test(slugRouteCode),
);
checkTrue(
  "shop.$slug.tsx 真的把它渲染出來（不是只 import）",
  /<SessionPicker\b/.test(slugRouteCode),
);
checkTrue(
  "只有 isBooking 才渲染場次選擇器",
  /\{isBooking \? \(\s*<SessionPicker\b/.test(slugRouteCode),
);

// 抽完要刪乾淨 —— 原本那段 inline JSX 一個標籤都不可以留在路由裡。
check("路由沒有殘留 <fieldset>", /<fieldset/.test(slugRouteCode), false);
check("路由沒有殘留 <legend>", /<legend/.test(slugRouteCode), false);
check("路由沒有殘留 aria-pressed 的場次按鈕", /aria-pressed/.test(slugRouteCode), false);
check("路由沒有殘留 sessions.map", /sessions\.map\(/.test(slugRouteCode), false);
// formatSessionWhen 也是搬走、不是複製 —— 兩份日期格式就是兩種顯示。
check(
  "路由不再自己定義 formatSessionWhen",
  /function formatSessionWhen/.test(slugRouteCode),
  false,
);
checkTrue(
  "SessionPicker 持有唯一那一份 formatSessionWhen",
  /function formatSessionWhen/.test(pickerCode),
);

// 元件不可以自己重算剩餘名額。remainingForSession() 同時是購物車行的上限與
// orders.ts 預檢的依據，第二份實作遲早會跟它們長歪。
checkTrue(
  "SessionPicker 從 @/lib/shop import remainingForSession",
  /import \{ remainingForSession, type ShopSession \} from "@\/lib\/shop";/.test(pickerCode),
);
checkTrue(
  "SessionPicker 真的呼叫 remainingForSession",
  /remainingForSession\(session\)/.test(pickerCode),
);
check(
  "SessionPicker 沒有自己碰 capacity／seatsTaken",
  /capacity|seatsTaken/.test(pickerCode),
  false,
);
check(
  "SessionPicker 沒有自己複製 ShopSession 型別",
  /type ShopSession = \{/.test(pickerCode),
  false,
);

// 選中的是哪一場由呼叫端持有 —— 那個 id 同時決定數量上限（remaining）與加入購物車
// 時帶的 selectedSession，藏進元件裡的話外面就得再想辦法問回來。
check("SessionPicker 不自己持有選中狀態（沒有 useState）", /useState/.test(pickerCode), false);
checkTrue("selectedId 由 props 傳入", /selectedId: string \| null;/.test(pickerCode));

// 行為不可以變的三件事。
checkTrue("額滿的場次仍然不能點", /disabled=\{full\}/.test(pickerCode));
checkTrue(
  "沒有場次時仍然顯示 noSessions 而不是空白",
  /sessions\.length === 0/.test(pickerCode) && /COPY\.noSessions/.test(pickerCode),
);
checkTrue(
  "換場次仍然把數量收回 1",
  /onSelect=\{\(id\) => \{\s*setSessionId\(id\);\s*setQty\(1\);\s*\}\}/.test(slugRouteCode),
);

// 「必須先選場次才能加入購物車」的守衛 —— 這條沒了就會送出 sessionId 為 null 的
// 活動訂單。
checkTrue(
  "加入購物車前仍擋沒選場次",
  /if \(isBooking && !selectedSession\) \{\s*toast\.error\(t\(PAGE\.pickSessionFirst\)\);\s*return;\s*\}/.test(
    slugRouteCode,
  ),
);

// 「尚餘名額」商品頁徽章與場次卡片共用同一份，不是各寫各的。
checkTrue(
  "labels.ts 匯出 SEATS_LEFT_LABEL",
  /export const SEATS_LEFT_LABEL: Localized = \{ zh: "尚餘名額"/.test(stripTs(shopLabelsTs)),
);
checkTrue("路由的名額徽章改用共用那一份", /t\(SEATS_LEFT_LABEL\)/.test(slugRouteCode));
checkTrue("SessionPicker 也用共用那一份", /t\(SEATS_LEFT_LABEL\)/.test(pickerCode));
check(
  "沒有第二份寫死的「尚餘名額」字面值",
  /"尚餘名額"/.test(slugRouteCode) || /"尚餘名額"/.test(pickerCode),
  false,
);

// --- log 紀律：不可以印整包 error ---------------------------------------------
// PostgREST 會把 Postgres 的 `DETAIL: Failing row contains (…)` 一路傳回來，
// 對 event_registrations 來說那一行就是某個人的姓名與電話。
console.log("\n[12] log 紀律（不可以把參加者個資寫進 log）");
// ⚠️ **新增任何碰 registrations 的檔案，就要加進這個清單。** 這條規則守的是
//    「參加者的姓名電話有沒有被寫進 Vercel 的 log」，而漏加一個檔案的後果是那個
//    檔案永遠不被檢查、而且沒有任何人會發現。0021 加了四個。
const piiSources = [
  ["src/server/repos/orders.ts", ordersTs],
  ["src/server/repos/event-registrations.ts", regRepoTs],
  ["src/server/repos/event-sessions.ts", sessionRepoTs],
  ["src/lib/admin/fns/event-registrations.ts", regFnTs],
  ["src/lib/admin/roster-csv.ts", readFile(join(ROOT, "src/lib/admin/roster-csv.ts"))],
  [
    "src/components/admin/RegistrationRevealDialog.tsx",
    readFile(join(ROOT, "src/components/admin/RegistrationRevealDialog.tsx")),
  ],
  [
    "src/routes/admin/_shell.registrations.tsx",
    readFile(join(ROOT, "src/routes/admin/_shell.registrations.tsx")),
  ],
];
for (const [name, src] of piiSources) {
  // 抓 console.error(...) 的整段參數，看有沒有把 error / err **物件本身**當成
  // 一個獨立的參數塞進去（`console.error("msg", error)`）。
  //
  // ⚠️ 先把樣板字串整段拿掉再比對。`${err instanceof Error ? err.message : String(err)}`
  //    是安全的寫法（印的是字串），但它裡面有 `(err)`，不先拿掉的話每一條這樣寫的
  //    log 都會被誤判 —— 這支測試第一次跑就是這樣紅的。
  const calls = stripTs(src).match(/console\.error\([\s\S]{0,400}?\);/g) ?? [];
  const bad = calls
    .map((c) => c.replace(/`[\s\S]*?`/g, "``").replace(/"[^"]*"/g, '""'))
    .filter((c) => /,\s*(error|err)\s*[,)]/.test(c) || /\(\s*(error|err)\s*\)/.test(c));
  check(`${name} 沒有 console.error(..., error) 這種寫法`, bad.length, 0);
  if (bad.length > 0) console.log(red(`      ${bad[0].slice(0, 160)}`));
}
// 反面對照 1：確認每個檔案裡真的有 console.error（否則 0 是因為根本沒有）。
checkTrue(
  "反空殼：orders.ts 裡確實有 console.error",
  (ordersTs.match(/console\.error\(/g) ?? []).length > 0,
);
// 反面對照 2：把偵測器餵一段**確定違規**的程式碼，它必須抓得到。
// 少了這一條，「0 個違規」有可能是偵測器自己壞掉 —— 而那正是這條規則最不能出錯的
// 失效方式（它守的是「參加者的姓名電話有沒有被寫進 Vercel 的 log」）。
for (const [label, sample, expected] of [
  ["console.error(msg, error)", "console.error(`[x] 失敗`, error);", 1],
  ["console.error(error)", "console.error(error);", 1],
  ["console.error(msg, err)", 'console.error("[x] 例外", err);', 1],
  ["安全寫法：只印 message", "console.error(`[x] ${error.code} ${error.message}`);", 0],
  [
    "安全寫法：String(err)",
    "console.error(`[x] ${err instanceof Error ? err.message : String(err)}`);",
    0,
  ],
]) {
  const calls = stripTs(sample).match(/console\.error\([\s\S]{0,400}?\);/g) ?? [];
  const hits = calls
    .map((c) => c.replace(/`[\s\S]*?`/g, "``").replace(/"[^"]*"/g, '""'))
    .filter((c) => /,\s*(error|err)\s*[,)]/.test(c) || /\(\s*(error|err)\s*\)/.test(c));
  check(`偵測器對「${label}」的判斷`, hits.length, expected);
}
checkTrue(
  "碰 registrations 的 log 只印 code 與 message",
  /error\.code\} \$\{error\.message\}/.test(regRepoTs) ||
    /\$\{error\.code\} \$\{error\.message\}/.test(regRepoTs),
);

// --- 名單只回遮罩值 ----------------------------------------------------------
console.log("\n[13] 名單頁不開明文出口");
checkTrue(
  "repo 回的是 email_masked / phone_masked",
  /email_masked/.test(regRepoTs) && /phone_masked/.test(regRepoTs),
);
// RegistrationRosterRow 這個對外型別裡不可以有明文 email / phone。
// ⚠️ 切到型別自己的 `};` 為止，不是切到下一個 /** —— 0021 之後這個型別裡面就有
//    JSDoc 註解了，用註解當終點會讓切出來的片段停在第一個欄位上，而那會讓下面
//    兩條「沒有明文欄位」變成永遠通過的假性斷言。
const rosterTypeStart = regRepoTs.indexOf("export type RegistrationRosterRow");
const rosterType = regRepoTs.slice(rosterTypeStart, regRepoTs.indexOf("\n};", rosterTypeStart) + 3);
checkTrue(
  "反空殼：切得出 RegistrationRosterRow",
  rosterType.length > 300,
  `實際 ${rosterType.length} 字`,
);
checkTrue("反空殼：切出來的片段有完整結尾", rosterType.trimEnd().endsWith("};"));
checkTrue("反空殼：切出來的片段包含最後一個欄位", /on_roster/.test(rosterType));
check("對外型別沒有明文 email 欄位", /^\s+email: string/m.test(rosterType), false);
check("對外型別沒有明文 phone 欄位", /^\s+phone: string/m.test(rosterType), false);

// ── 0021 開了那兩條明文出口 ────────────────────────────────────────────────
//
// ⚠️ 這兩條在 Phase 1 是反過來寫的（`, false`），而那就是當時的設計意圖：
//    **明文出口不可以在沒有 pii_access_log 的情況下先上線。** 0021 §5／§6 建了那
//    兩支會留痕的函式、§1 加了對應的 reason，所以現在翻面。
//
//    翻面之後這兩條仍然有意義：它們守著「repo 真的走那兩支 SQL 函式」，而不是
//    某天有人加一條 `.select("email, phone")` 就把明文撈出來 —— 那條路不會留痕。
//    下面「明文只有兩個出口」那一段是同一件事的另一半。
checkTrue(
  "0021 之後有 reveal 出口（會留痕）",
  /reveal_registration_contact/.test(stripTs(regRepoTs)),
);
checkTrue(
  "0021 之後有 CSV 匯出（會留痕）",
  /export_event_roster/.test(stripTs(regRepoTs)) && /roster-csv/.test(stripTs(regFnTs)),
);
// 報名資料只由 SQL 函式寫，repo 不可以有 insert/delete。
check("registrations repo 沒有 insert", /\.insert\(/.test(regRepoTs), false);
check("registrations repo 沒有 delete", /\.delete\(/.test(regRepoTs), false);
// ⚠️ registrations 那一側在 0021 從 adminFnMiddleware 換成 staffFnMiddleware() +
//    event.roster.read（0021 §4 的第九種權限）。sessions 那一側的**寫入**仍然是
//    adminFnMiddleware，讀取跟著名單走 —— 場次本來就是 anon 讀得到的公開資訊。
checkTrue(
  // stripTs 先把註解拿掉：檔頭那段講「Phase 1 掛的是 adminFnMiddleware」的說明
  // 不算掛載，但字面上會命中。
  "registrations 的 fn 掛 staffFnMiddleware",
  /staffFnMiddleware/.test(stripTs(regFnTs)) && !/adminFnMiddleware/.test(stripTs(regFnTs)),
);
check(
  "middleware 的掛載數 = 匯出的 server fn 數（registrations）",
  (regFnTs.match(/\.middleware\(\[staffFnMiddleware\(\)\]\)/g) ?? []).length,
  (regFnTs.match(/export const \w+ = createServerFn/g) ?? []).length,
);
check(
  "middleware 的掛載數 = 匯出的 server fn 數（sessions）",
  (sessionFnTs.match(/\.middleware\(\[(adminFnMiddleware|staffFnMiddleware\(\))\]\)/g) ?? [])
    .length,
  (sessionFnTs.match(/export const \w+ = createServerFn/g) ?? []).length,
);
checkTrue(
  "場次的寫入仍然是 adminFnMiddleware",
  /upsertEventSession[\s\S]{0,200}?middleware\(\[adminFnMiddleware\]\)/.test(sessionFnTs) &&
    /removeEventSession[\s\S]{0,300}?middleware\(\[adminFnMiddleware\]\)/.test(sessionFnTs),
);
// repo 慣例
checkTrue(
  "兩支 repo 第一行都是 server-only",
  /^import "@tanstack\/react-start\/server-only";/m.test(regRepoTs) &&
    /^import "@tanstack\/react-start\/server-only";/m.test(sessionRepoTs),
);
checkTrue("event-sessions repo 有頂部 COLUMNS 常數", /^const COLUMNS =/m.test(sessionRepoTs));
// seats_taken 永遠不可以被表單寫回去。
check(
  "event-sessions 的 upsert payload 沒有 seats_taken",
  /seats_taken:/.test(stripTs(sessionRepoTs).split("const payload = {")[1]?.split("};")[0] ?? ""),
  false,
);

// --- products 那一側不再寫 capacity ------------------------------------------
console.log("\n[14] products 不再持有名額");
check(
  "products repo 的 upsert 不寫 capacity",
  /capacity: input\.capacity/.test(productsRepoTs),
  false,
);
check(
  "productSchema 沒有 capacity 欄位",
  /capacity: z$/m.test(readFile(join(ROOT, "src/lib/admin/schemas.ts"))),
  false,
);
check("商品後台表單沒有 capacity 輸入框", /name="capacity"/.test(productsRouteTs), false);
checkTrue("商品後台改為指向場次頁", /活動報名/.test(productsRouteTs));
checkTrue(
  "新增了 eventSessionSchema",
  /export const eventSessionSchema/.test(readFile(join(ROOT, "src/lib/admin/schemas.ts"))),
);

// --- checkout 的分工註解 -----------------------------------------------------
console.log("\n[15] checkout 的分工");
checkTrue(
  "checkoutItemSchema 收得到 sessionId",
  /sessionId: z\.string\(\)\.uuid\(\)\.nullable\(\)\.optional\(\)/.test(checkoutTs),
);
checkTrue(
  "checkoutItemSchema 收得到 participants",
  /participants: z[\s\S]{0,200}\.array\(/.test(checkoutTs),
);
checkTrue(
  "註解寫明 zod 只是體驗、保證在 reserve_session_seat",
  /reserve_session_seat\(\) (的第 ① 步|step ③)/.test(checkoutTs),
);
// participants 不可以帶任何金額欄位。
const participantSchemaBody = checkoutTs.slice(
  checkoutTs.indexOf("function participantSchema("),
  checkoutTs.indexOf("export function checkoutFormSchema("),
);
checkTrue("反空殼：切得出 participantSchema", participantSchemaBody.length > 300);
check(
  "participantSchema 沒有任何金額欄位",
  /(price|amount|total|subtotal|fee)\s*:/i.test(participantSchemaBody),
  false,
);
checkTrue("同意欄位是必填", /if \(!value\.noticeAck\)/.test(participantSchemaBody));

// --- migration 套用前的行為必須完全不變 ---------------------------------------
// 程式碼會先上線、0020 後套用。中間那段時間 event_sessions 這張表根本不存在，
// 所以任何「一定會查它」的路徑都會炸掉整個結帳。這一條守著：只有購物車裡真的
// 有活動時才碰它。
console.log("\n[16] 0020 未套用時，書籍結帳的行為完全不變");
checkTrue(
  "只有 sessionIds 非空才查 event_sessions",
  /if \(sessionIds\.length > 0\) \{[\s\S]{0,400}from\("event_sessions"\)/.test(ordersTs),
);
checkTrue(
  "只有 bookings 非空才查場次（shop.ts）",
  /if \(!db \|\| bookings\.length === 0\) return;/.test(shopTs),
);
checkTrue(
  "只有 booking 行才呼叫 reserve_session_seat",
  /\.filter\(\(l\) => isBooking\(l\.productType\)\)[\s\S]{0,400}rpc\("reserve_session_seat"/.test(
    ordersTs,
  ),
);
// PRODUCT_COLUMNS 仍然帶著那兩欄 —— drop 掉會讓舊 bundle 收到 400。
checkTrue("PRODUCT_COLUMNS 仍保留 capacity, seats_taken", /capacity, seats_taken/.test(ordersTs));
checkTrue("shop.ts 的 COLUMNS 仍保留 capacity, seats_taken", /capacity, seats_taken/.test(shopTs));
checkTrue(
  "products repo 的 COLUMNS 仍保留 capacity, seats_taken",
  /capacity, seats_taken/.test(productsRepoTs),
);

// =============================================================================
// 併發段
// =============================================================================

const PG_URL = process.env.EVENT_SELFTEST_PG_URL;

/**
 * 送一句 SQL，一次一條**獨立連線**（一個 psql 子行程）。**不 throw** ——
 * 併發測試需要拿到「誰失敗了、為什麼」，而不是被第一個預期中的失敗炸掉。
 *
 * select 會被包成 json_agg 再解析，好讓回傳值與既有幾支自檢的 rows 形狀一致。
 * 判斷方式很簡單（以 select 開頭、而且只有一句），因為這個檔案裡的 SQL 全是自己寫的。
 */
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

const MARK = "__evtselftest__";
const SLUG_PREFIX = "evtselftest-";
const KEY_PREFIX = "evtselftest-";

/** FK 安全的清理順序。開頭與結尾各跑一次。 */
const CLEANUP_SQL = `
delete from public.event_registrations r
 where r.order_id in (select o.id from public.orders o where o.idempotency_key like '${KEY_PREFIX}%')
    or r.session_id in (select s.id from public.event_sessions s
                         where s.product_id like '${SLUG_PREFIX}%');
delete from public.orders where idempotency_key like '${KEY_PREFIX}%';
delete from public.event_sessions where product_id like '${SLUG_PREFIX}%';
delete from public.products where id like '${SLUG_PREFIX}%';
`;

if (!PG_URL) {
  skipped.push("併發測試（缺 EVENT_SELFTEST_PG_URL）");
  console.log(yellow("\n[17–23] 併發測試 —— 跳過：沒有 EVENT_SELFTEST_PG_URL"));
  console.log(
    yellow("       設好之後重跑，才會驗到超賣、原子性、跨商品竄改、回滾冪等、過期回收、死鎖、"),
  );
  console.log(yellow("       以及 migration 冪等這七條。指令見本檔檔頭。"));
} else {
  try {
    if (process.env.EVENT_SELFTEST_APPLY === "1") {
      console.log("\n[17] 套用 0001–0020（EVENT_SELFTEST_APPLY=1）");
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
        // 0008 要 pg_net + vault + pg_cron，本機沒有。跳過它不影響這一期要驗的
        // 任何東西（它只是「有人去打補開發票的端點」的排程）。
        if (f.startsWith("0008_") || f.startsWith("0020_")) continue;
        const r = await q(readFile(join(ROOT, "supabase/migrations", f)));
        if (!r.ok) throw new Error(`套用 ${f} 失敗：${r.error.slice(0, 600)}`);
      }
      checkTrue("0001–0019 套用完成（0008 跳過）", true);

      // ---- 0020 **還沒套用**時，賣書的那一條路必須一模一樣 -------------------
      // ⚠️ 程式碼先上線、migration 後套用，所以這個中間狀態是真的會發生的。
      //    order_items 那時候還沒有 session_id 這一欄，所以 orders.ts 的 step 3
      //    在購物車裡沒有活動時**整批都不送這一欄**（anySession = false）。
      //    這一段就是驗那個形狀在 0019 的 schema 上真的成立。
      console.log("\n[17a] 0020 未套用時：賣書的 insert 形狀");
      check(
        "order_items 這時候沒有 session_id 欄位",
        Number(
          one(
            await must(`select count(*)::int n from information_schema.columns
                         where table_schema='public' and table_name='order_items'
                           and column_name='session_id'`),
          ).n,
        ),
        0,
      );
      await must(`
        insert into public.products (id, slug, product_type, title, summary, description, price, stock, status)
        values ('${SLUG_PREFIX}pre','${SLUG_PREFIX}pre','book',
                '{"zh":"a","en":"a","ja":"a"}','{"zh":"a","en":"a","ja":"a"}','{"zh":"a","en":"a","ja":"a"}',
                380, 5, 'active');
        insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
        values ('selftest','selftest@example.invalid','0900000000',380,380,'${KEY_PREFIX}pre-1');
      `);
      // 這正是 anySession === false 時 orders.ts 送出去的欄位組合。
      const preInsert = await q(`
        insert into public.order_items
          (order_id, product_id, name, unit_price, quantity, subtotal, product_type)
        select id, '${SLUG_PREFIX}pre', '{"zh":"a","en":"a","ja":"a"}', 380, 1, 380, 'book'
          from public.orders where idempotency_key = '${KEY_PREFIX}pre-1'`);
      checkTrue("不帶 session_id 的批次 insert 成功（＝今天的行為）", preInsert.ok);
      if (!preInsert.ok) console.log(red(`      ${preInsert.error.slice(0, 300)}`));
      // 反面對照：帶了 session_id 就會炸 —— 證明上面那條不是因為欄位剛好存在。
      const preInsertWithCol = await q(`
        insert into public.order_items
          (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
        select id, '${SLUG_PREFIX}pre', null, '{"zh":"a","en":"a","ja":"a"}', 380, 1, 380, 'book'
          from public.orders where idempotency_key = '${KEY_PREFIX}pre-1'`);
      checkTrue(
        "反面對照：帶了 session_id 會失敗（欄位不存在）",
        !preInsertWithCol.ok && /session_id/.test(preInsertWithCol.error),
      );
      await must(`
        delete from public.orders where idempotency_key = '${KEY_PREFIX}pre-1';
        delete from public.products where id = '${SLUG_PREFIX}pre';
      `);

      // ---- 現在才套 0020 ----------------------------------------------------
      const apply0020 = await q(readFile(MIG_0020));
      checkTrue("0020 套用成功", apply0020.ok);
      if (!apply0020.ok) throw new Error(`套用 0020 失敗：${apply0020.error.slice(0, 600)}`);

      // ---- migration 冪等：0020 再套一次，第二次必須零錯誤 -------------------
      const again = await q(readFile(MIG_0020));
      checkTrue("0020 套第二次零錯誤（冪等）", again.ok);
      if (!again.ok) console.log(red(`      ${again.error.slice(0, 300)}`));
    }

    console.log("\n[18] 前置：清理殘骸並建立測試資料");
    await must(CLEANUP_SQL);

    const LOC = `'{"zh":"自檢","en":"selftest","ja":"セルフテスト"}'::jsonb`;
    const S = { a: `${SLUG_PREFIX}a`, b: `${SLUG_PREFIX}b` };
    const SESS = {
      one: "bbbb0000-0000-4000-8000-000000000001", // capacity 1，測超賣
      atom: "bbbb0000-0000-4000-8000-000000000002", // 測數量不符
      other: "bbbb0000-0000-4000-8000-000000000003", // B 商品的場次，測跨商品竄改
      exp: "bbbb0000-0000-4000-8000-000000000004", // 測過期回收
      lockA: "bbbb0000-0000-4000-8000-000000000005", // 死鎖 A
      lockB: "bbbb0000-0000-4000-8000-000000000006", // 死鎖 B
    };

    await must(`
      insert into public.products (id, slug, product_type, title, summary, description, price, requires_shipping, status) values
        ('${S.a}','${S.a}','event',${LOC},${LOC},${LOC},500,false,'active'),
        ('${S.b}','${S.b}','event',${LOC},${LOC},${LOC},500,false,'active');
      insert into public.event_sessions (id, product_id, title, location, starts_at, capacity, status) values
        ('${SESS.one}',  '${S.a}',${LOC},${LOC}, now() + interval '30 days', 1,  'open'),
        ('${SESS.atom}', '${S.a}',${LOC},${LOC}, now() + interval '31 days', 10, 'open'),
        ('${SESS.other}','${S.b}',${LOC},${LOC}, now() + interval '32 days', 10, 'open'),
        ('${SESS.exp}',  '${S.a}',${LOC},${LOC}, now() + interval '33 days', 10, 'open'),
        ('${SESS.lockA}','${S.a}',${LOC},${LOC}, now() + interval '34 days', 99, 'open'),
        ('${SESS.lockB}','${S.b}',${LOC},${LOC}, now() + interval '35 days', 99, 'open');
    `);
    checkTrue("fixture 建立完成", true);

    const people = (n) =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({
          name: `自檢${i + 1}`,
          email: `p${i + 1}@example.invalid`,
          noticeAck: "true",
        })),
      );

    /**
     * ⚠️ 交易邊界照 src/server/repos/orders.ts 切，不是圖方便包成一個 do 區塊。
     *
     * 正式環境走 PostgREST，**一個 HTTP 請求就是一個交易**：step 2–4b（訂單、明細、
     * 地址、發票）是一個交易，step 5 的每一次 reserve_session_seat 各自又是一個。
     * 把它們全部塞進同一個 do 區塊會製造出正式環境不存在的鎖競爭 —— 而且反過來，
     * 它也會漏掉正式環境真的會遇到的那一種（前一個交易已經 commit，鎖已經放掉）。
     *
     * 所以 bookSetupSql() 是「一個交易」，bookReserveSql() 是「另一個交易」。
     */
    const bookSetupSql = (key, bookings) => `
      do $$
      declare v_order uuid;
      begin
        insert into public.orders
          (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
        values ('selftest','selftest@example.invalid','0900000000',500,500,'${key}')
        returning id into v_order;
        ${bookings
          .map(
            (b, i) => `
        insert into public.order_items
          (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
        values (v_order, '${b.product}', '${b.seatSession ?? b.session}', ${LOC}, 500, ${b.qty}, 500, 'event');`,
          )
          .join("\n")}
      end $$;
    `;

    /** step 5 的一次呼叫 = 一個交易。`nth` 指的是這張訂單的第幾個明細（0 起算）。 */
    const bookReserveSql = (key, b, nth) => `
      do $$
      declare v_order uuid; v_item bigint;
      begin
        select id into v_order from public.orders where idempotency_key = '${key}';
        select id into v_item from (
          select oi.id, row_number() over (order by oi.id) rn
            from public.order_items oi where oi.order_id = v_order) t
         where t.rn = ${nth + 1};
        perform public.reserve_session_seat(v_order, v_item, '${b.session}', ${b.qty},
          '${people(b.people ?? b.qty)}'::jsonb);
      end $$;
    `;

    /** 一次完整的下單：先 setup 交易，再逐筆 reserve 交易。任何一步失敗就回那個失敗。 */
    async function book(key, bookings) {
      const setup = await q(bookSetupSql(key, bookings));
      if (!setup.ok) return setup;
      for (let i = 0; i < bookings.length; i++) {
        const r = await q(bookReserveSql(key, bookings[i], bookings[i].nth ?? i));
        if (!r.ok) return r;
      }
      return { ok: true, error: null, rows: [] };
    }

    /** 同一個交易裡插明細再連續 reserve —— 用來驗鎖模式與函式內排序（見 [24b]）。 */
    const bookOneTxnSql = (key, bookings) => `
      do $$
      declare v_order uuid; v_ids bigint[];
      begin
        insert into public.orders
          (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
        values ('selftest','selftest@example.invalid','0900000000',500,500,'${key}')
        returning id into v_order;
        ${bookings
          .map(
            (b) => `
        insert into public.order_items
          (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
        values (v_order, '${b.product}', '${b.session}', ${LOC}, 500, ${b.qty}, 500, 'event');`,
          )
          .join("\n")}
        select array_agg(oi.id order by oi.id) into v_ids
          from public.order_items oi where oi.order_id = v_order;
        ${bookings
          .map(
            (b, i) => `
        perform public.reserve_session_seat(v_order, v_ids[${i + 1}], '${b.session}', ${b.qty},
          '${people(b.qty)}'::jsonb);`,
          )
          .join("\n")}
      end $$;
    `;

    // -------------------------------------------------------------------------
    // [19] 超賣：capacity 1，20 個並行
    // -------------------------------------------------------------------------
    console.log("\n[19] 超賣 —— capacity=1，同時發 20 個報名請求");
    const race = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        book(`${KEY_PREFIX}race-${i}`, [{ product: S.a, session: SESS.one, qty: 1 }]),
      ),
    );
    const won = race.filter((r) => r.ok);
    const lost = race.filter((r) => !r.ok);
    check("恰好 1 個成功", won.length, 1);
    check("其餘 19 個失敗", lost.length, 19);
    check(
      "19 個失敗全部是 NO_SEATS_LEFT",
      lost.filter((r) => /NO_SEATS_LEFT/.test(r.error)).length,
      19,
    );
    if (lost.some((r) => !/NO_SEATS_LEFT/.test(r.error))) {
      console.log(
        red(
          `      非預期錯誤範例：${lost.find((r) => !/NO_SEATS_LEFT/.test(r.error)).error.slice(0, 300)}`,
        ),
      );
    }
    check(
      "seats_taken = 1",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.one}'`)).n,
      ),
      1,
    );
    check(
      "registrations 恰好 1 列",
      Number(
        one(
          await must(
            `select count(*)::int n from public.event_registrations where session_id='${SESS.one}'`,
          ),
        ).n,
      ),
      1,
    );

    // -------------------------------------------------------------------------
    // [20] 數量不符的原子性
    // -------------------------------------------------------------------------
    console.log("\n[20] 原子性 —— quantity=2 但只給 1 位參加者");
    const atomBefore = Number(
      one(await must(`select seats_taken n from public.event_sessions where id='${SESS.atom}'`)).n,
    );
    const mismatch = await book(`${KEY_PREFIX}atom-1`, [
      { product: S.a, session: SESS.atom, qty: 2, people: 1 },
    ]);
    checkTrue("被拒絕", !mismatch.ok);
    checkTrue(
      "錯誤是 PARTICIPANT_COUNT_MISMATCH",
      /PARTICIPANT_COUNT_MISMATCH/.test(mismatch.error ?? ""),
    );
    check(
      "seats_taken 完全沒變",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.atom}'`))
          .n,
      ),
      atomBefore,
    );
    check(
      "registrations 0 列",
      Number(
        one(
          await must(
            `select count(*)::int n from public.event_registrations where session_id='${SESS.atom}'`,
          ),
        ).n,
      ),
      0,
    );

    // -------------------------------------------------------------------------
    // [21] 跨商品竄改：A 的 order_item + B 的場次
    // -------------------------------------------------------------------------
    // 這是加了 sessionId 之後**新開的攻擊面**：付 A 商品的錢、訂 B 場次的位子。
    console.log("\n[21] 跨商品竄改 —— A 的 order_item 配 B 的場次");
    const otherBefore = Number(
      one(await must(`select seats_taken n from public.event_sessions where id='${SESS.other}'`)).n,
    );
    // order_items 的 session_id 寫 A 自己的（過得了那條 CHECK），但 RPC 傳 B 的。
    const tamper = await book(`${KEY_PREFIX}tamper-1`, [
      { product: S.a, session: SESS.other, seatSession: SESS.atom, qty: 1 },
    ]);
    checkTrue("被拒絕", !tamper.ok);
    checkTrue(
      "錯誤是 SESSION_PRODUCT_MISMATCH",
      /SESSION_PRODUCT_MISMATCH/.test(tamper.error ?? ""),
    );
    check(
      "B 場次的 seats_taken 沒變",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.other}'`))
          .n,
      ),
      otherBefore,
    );

    // 另一半：order_item 屬於別張訂單。
    await must(`
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values ('selftest','selftest@example.invalid','0900000000',500,500,'${KEY_PREFIX}foreign-1');
      insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
      select id, '${S.a}', '${SESS.atom}', ${LOC}, 500, 1, 500, 'event'
        from public.orders where idempotency_key='${KEY_PREFIX}foreign-1';
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values ('selftest','selftest@example.invalid','0900000000',500,500,'${KEY_PREFIX}foreign-2');
    `);
    const crossOrder = await q(`
      select public.reserve_session_seat(
        (select id from public.orders where idempotency_key='${KEY_PREFIX}foreign-2'),
        (select oi.id from public.order_items oi join public.orders o on o.id=oi.order_id
          where o.idempotency_key='${KEY_PREFIX}foreign-1'),
        '${SESS.atom}', 1,
        '[{"name":"x","email":"x@example.invalid"}]'::jsonb) n`);
    checkTrue("借用別張訂單的 order_item 被拒絕", !crossOrder.ok);
    checkTrue(
      "錯誤是 ORDER_ITEM_ORDER_MISMATCH",
      /ORDER_ITEM_ORDER_MISMATCH/.test(crossOrder.error ?? ""),
    );

    // 場次沒開也不行。
    await must(`update public.event_sessions set status='closed' where id='${SESS.other}'`);
    const closed = await book(`${KEY_PREFIX}closed-1`, [
      { product: S.b, session: SESS.other, qty: 1 },
    ]);
    checkTrue("closed 的場次報不了名", !closed.ok && /SESSION_NOT_OPEN/.test(closed.error ?? ""));
    await must(`update public.event_sessions set status='open' where id='${SESS.other}'`);

    // -------------------------------------------------------------------------
    // [22] 回滾冪等
    // -------------------------------------------------------------------------
    console.log("\n[22] 回滾冪等 —— 同一個 order_item 連呼叫 release 兩次");
    const rel1 = await book(`${KEY_PREFIX}rel-1`, [{ product: S.a, session: SESS.atom, qty: 3 }]);
    if (!rel1.ok) throw new Error(`rel-1 下單失敗：${rel1.error.slice(0, 300)}`);
    const relItem = Number(
      one(
        await must(`select oi.id n from public.order_items oi join public.orders o on o.id=oi.order_id
                     where o.idempotency_key='${KEY_PREFIX}rel-1'`),
      ).n,
    );
    const takenBeforeRelease = Number(
      one(await must(`select seats_taken n from public.event_sessions where id='${SESS.atom}'`)).n,
    );
    check("先佔了 3 個位子", takenBeforeRelease, 3);
    check(
      "第一次 release 回 3",
      Number(one(await must(`select public.release_session_seat(${relItem}) n`)).n),
      3,
    );
    check(
      "第二次 release 回 0",
      Number(one(await must(`select public.release_session_seat(${relItem}) n`)).n),
      0,
    );
    check(
      "seats_taken 只降一次",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.atom}'`))
          .n,
      ),
      0,
    );
    check(
      "registrations 也回收了",
      Number(
        one(
          await must(
            `select count(*)::int n from public.event_registrations where order_item_id=${relItem}`,
          ),
        ).n,
      ),
      0,
    );
    // 併發版：5 個同時 release，總和仍然只有 3。
    const rel2 = await book(`${KEY_PREFIX}rel-2`, [{ product: S.a, session: SESS.atom, qty: 3 }]);
    if (!rel2.ok) throw new Error(`rel-2 下單失敗：${rel2.error.slice(0, 300)}`);
    const relItem2 = Number(
      one(
        await must(`select oi.id n from public.order_items oi join public.orders o on o.id=oi.order_id
                     where o.idempotency_key='${KEY_PREFIX}rel-2'`),
      ).n,
    );
    const parallelRelease = await Promise.all(
      Array.from({ length: 5 }, () => q(`select public.release_session_seat(${relItem2}) n`)),
    );
    const freedTotal = parallelRelease
      .filter((r) => r.ok)
      .reduce((sum, r) => sum + Number(one(r.rows)?.n ?? 0), 0);
    check("5 個並行 release 的回傳總和 = 3", freedTotal, 3);
    check(
      "seats_taken 回到 0",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.atom}'`))
          .n,
      ),
      0,
    );

    // -------------------------------------------------------------------------
    // [23] 過期回收
    // -------------------------------------------------------------------------
    console.log("\n[23] 過期回收 —— 未付款的訂單被 expire_unpaid_orders 收回");
    const exp1 = await book(`${KEY_PREFIX}exp-1`, [{ product: S.a, session: SESS.exp, qty: 2 }]);
    if (!exp1.ok) throw new Error(`exp-1 下單失敗：${exp1.error.slice(0, 300)}`);
    const expOrderNo = one(
      await must(`select order_no n from public.orders where idempotency_key='${KEY_PREFIX}exp-1'`),
    ).n;
    check(
      "先佔了 2 個位子",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.exp}'`)).n,
      ),
      2,
    );
    const expired = await must(
      `select expired_order_no, restored_stock, restored_seats from public.expire_unpaid_orders(interval '0', 200)`,
    );
    // ⚠️ 對到**自己那一張**訂單。expire_unpaid_orders 沒辦法只掃一張單，前面幾條
    //    測試留下的 pending 訂單也會被一起收掉，取第一列會拿到別人的數字。
    const mine = expired.find((r) => r.expired_order_no === expOrderNo);
    checkTrue("有訂單被過期回收", expired.length > 0);
    checkTrue("找得到自己那一張", Boolean(mine));
    check("restored_seats = 2", Number(mine?.restored_seats ?? -1), 2);
    check(
      "seats_taken 回到 0",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.exp}'`)).n,
      ),
      0,
    );
    check(
      "registrations 0 列",
      Number(
        one(
          await must(
            `select count(*)::int n from public.event_registrations where session_id='${SESS.exp}'`,
          ),
        ).n,
      ),
      0,
    );
    check(
      "訂單被取消",
      one(
        await must(`select status s from public.orders where idempotency_key='${KEY_PREFIX}exp-1'`),
      )?.s,
      "cancelled",
    );

    // -------------------------------------------------------------------------
    // [24] 死鎖：兩張訂單各含 A、B 兩個場次但順序相反
    // -------------------------------------------------------------------------
    console.log("\n[24] 死鎖 —— 兩個場次、順序相反、同時發 16 個");
    const pairs = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        book(
          `${KEY_PREFIX}lock-${i}`,
          i % 2 === 0
            ? [
                { product: S.a, session: SESS.lockA, qty: 1 },
                { product: S.b, session: SESS.lockB, qty: 1 },
              ]
            : [
                { product: S.b, session: SESS.lockB, qty: 1 },
                { product: S.a, session: SESS.lockA, qty: 1 },
              ],
        ),
      ),
    );
    const deadlocks = pairs.filter((r) => !r.ok && /deadlock detected/i.test(r.error));
    const otherErrors = pairs.filter((r) => !r.ok && !/deadlock detected/i.test(r.error));
    check("沒有任何一筆 deadlock detected", deadlocks.length, 0);
    check("16 筆全部完成（名額 99 綽綽有餘）", pairs.filter((r) => r.ok).length, 16);
    check("沒有其他非預期錯誤", otherErrors.length, 0);
    check(
      "A 場次 seats_taken = 16",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.lockA}'`))
          .n,
      ),
      16,
    );
    check(
      "B 場次 seats_taken = 16",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.lockB}'`))
          .n,
      ),
      16,
    );

    // -------------------------------------------------------------------------
    // [24b] 同一個交易裡插明細再連續佔位（鎖模式 + 函式內排序）
    // -------------------------------------------------------------------------
    // 這一條驗的是 0020 §2 那兩個 ⚠️，而它們都是這支測試實際打出來的：
    //
    //   1. order_items 的外鍵會對 event_sessions 取 FOR KEY SHARE。如果 reserve
    //      用 FOR UPDATE，同一個交易裡「先 insert 再 reserve」就是一次鎖升級，
    //      兩個併發請求各自等對方 → 死鎖。改成 FOR NO KEY UPDATE 之後不再升級。
    //
    //   2. 兩個場次、順序相反、同一個交易 → ABBA 死鎖。reserve 內部先把整張訂單
    //      會碰到的場次依 id 排序鎖起來，所以呼叫端的順序不影響加鎖順序。
    //
    // 正式環境的 orders.ts 兩件事都避開了（交易分開、而且自己有排序），但這一條
    // 守的是「未來任何一條新的呼叫路徑都不必重新推導一次」。
    console.log("\n[24b] 同一交易內插明細＋逆序連續佔位 —— 不可以死鎖");
    const oneTxn = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        q(
          bookOneTxnSql(
            `${KEY_PREFIX}txn-${i}`,
            i % 2 === 0
              ? [
                  { product: S.a, session: SESS.lockA, qty: 1 },
                  { product: S.b, session: SESS.lockB, qty: 1 },
                ]
              : [
                  { product: S.b, session: SESS.lockB, qty: 1 },
                  { product: S.a, session: SESS.lockA, qty: 1 },
                ],
          ),
        ),
      ),
    );
    const txnDeadlocks = oneTxn.filter((r) => !r.ok && /deadlock detected/i.test(r.error));
    check("沒有任何一筆 deadlock detected", txnDeadlocks.length, 0);
    check("12 筆全部完成", oneTxn.filter((r) => r.ok).length, 12);
    if (oneTxn.some((r) => !r.ok)) {
      console.log(red(`      錯誤範例：${oneTxn.find((r) => !r.ok).error.slice(0, 300)}`));
    }
    check(
      "A 場次 seats_taken = 28（16 + 12）",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${SESS.lockA}'`))
          .n,
      ),
      28,
    );

    // -------------------------------------------------------------------------
    // [25] 搬家完成 + 書籍路徑不受影響
    // -------------------------------------------------------------------------
    console.log("\n[25] 搬家完成，且書籍路徑不受影響");
    check(
      "沒有任何 products 還持有名額",
      Number(
        one(
          await must(
            `select count(*)::int n from public.products where capacity is not null or seats_taken <> 0`,
          ),
        ).n,
      ),
      0,
    );
    // 一件普通的書：庫存扣除、可售量、過期回收全部照 0011 的老路走。
    await must(`
      insert into public.products (id, slug, product_type, title, summary, description, price, stock, status)
      values ('${SLUG_PREFIX}book','${SLUG_PREFIX}book','book',${LOC},${LOC},${LOC},380,5,'active');
    `);
    await must(
      `select public.atomic_deduct_stock('[{"product_id":"${SLUG_PREFIX}book","quantity":2}]'::jsonb)`,
    );
    check(
      "atomic_deduct_stock 照舊：5 → 3",
      Number(
        one(await must(`select stock n from public.products where id='${SLUG_PREFIX}book'`)).n,
      ),
      3,
    );
    check(
      "可售量 view 對書回報型錄庫存",
      Number(
        one(
          await must(
            `select available_capped n from public.product_availability where product_id='${SLUG_PREFIX}book'`,
          ),
        ).n,
      ),
      3,
    );
    // 活動商品在 view 裡回報的是「open 場次的最大剩餘」，不是 else 分支的 10。
    check(
      "可售量 view 對活動回報場次剩餘（不是 fail-open 的 10）",
      Number(
        one(
          await must(
            `select available_capped n from public.product_availability where product_id='${S.a}'`,
          ),
        ).n,
      ),
      // lockA 99 - 16 = 83 → capped 10；但 one/atom/exp 都比它小，取 max 之後再 cap。
      10,
    );
    await must(`update public.event_sessions set status='closed' where product_id='${S.a}'`);
    check(
      "全部場次關閉後，活動商品的可售量是 0（fail-closed）",
      Number(
        one(
          await must(
            `select available_capped n from public.product_availability where product_id='${S.a}'`,
          ),
        ).n,
      ),
      0,
    );

    // order_items 的形狀 CHECK 兩個方向都要擋。
    const badBook = await q(`
      insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
      select id, '${SLUG_PREFIX}book', '${SESS.atom}', ${LOC}, 380, 1, 380, 'book'
        from public.orders where idempotency_key='${KEY_PREFIX}foreign-2'`);
    checkTrue(
      "書帶了 session_id 會被 CHECK 擋下",
      !badBook.ok && /order_items_session_shape/.test(badBook.error),
    );
    const badEvent = await q(`
      insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
      select id, '${S.a}', null, ${LOC}, 500, 1, 500, 'event'
        from public.orders where idempotency_key='${KEY_PREFIX}foreign-2'`);
    checkTrue(
      "活動沒帶 session_id 也會被擋下",
      !badEvent.ok && /order_items_session_shape/.test(badEvent.error),
    );

    // products 的名額 CHECK。
    const badCapacity = await q(
      `update public.products set capacity = 10 where id='${SLUG_PREFIX}book'`,
    );
    checkTrue(
      "往 products.capacity 寫值會被擋下",
      !badCapacity.ok && /products_capacity_moved_to_sessions/.test(badCapacity.error),
    );

    // reserve_product_seat 自我失效：capacity 是 null，它一定 raise。
    const legacySeat = await q(`select public.reserve_product_seat('${S.a}', 1)`);
    checkTrue(
      "舊的 reserve_product_seat 自我失效（NOT_BOOKABLE）",
      !legacySeat.ok && /NOT_BOOKABLE/.test(legacySeat.error),
    );
  } catch (err) {
    // 記成一條失敗再往下走，而不是讓例外殺掉整個行程 —— 直接炸掉的話收尾的
    // ##SELFTEST## 那一行印不出來，runner 只會說「沒有印出收尾行」，已經跑完的
    // 結果全部看不到。
    fail += 1;
    console.log(red(`  ✗ 併發測試中止：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    console.log("\n[26] 清理");
    const cleanup = await q(CLEANUP_SQL);
    const cleanupBook = await q(`delete from public.products where id like '${SLUG_PREFIX}%'`);
    checkTrue("測試資料清乾淨", cleanup.ok && cleanupBook.ok);
    check(
      "沒有殘留的 event_sessions",
      Number(
        one(
          (
            await q(
              `select count(*)::int n from public.event_sessions where product_id like '${SLUG_PREFIX}%'`,
            )
          ).rows,
        )?.n ?? -1,
      ),
      0,
    );
    check(
      "沒有殘留的 event_registrations",
      Number(
        one((await q(`select count(*)::int n from public.event_registrations`)).rows)?.n ?? -1,
      ),
      0,
    );
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
