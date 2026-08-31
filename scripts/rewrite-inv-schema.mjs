#!/usr/bin/env node
/**
 * rewrite-inv-schema.mjs —— 把進銷存的 public schema 機械改寫成 inv schema
 *
 * ── 為什麼要寫成腳本，而不是手工改那 3,200 行 SQL ────────────────────────────
 * 手改的 SQL 沒辦法回答三個問題：改了幾處？漏了哪處？下次備份更新怎麼重來？
 * 這支腳本讓改寫**可重跑、可 review、可解釋** —— 每一條規則命中幾次都印在
 * stdout，數字對不上就代表來源變了，而不是「大概沒事」。
 *
 * 輸入：pg_restore --schema-only --schema=public --no-owner 的輸出
 * 輸出：supabase/migrations/0009_inventory_schema.sql 的主體
 *
 * 用法：
 *   pg_restore --schema-only --schema=public --no-owner \
 *     -f /tmp/src_public_schema.sql bookstock_260815.backup
 *   node scripts/rewrite-inv-schema.mjs /tmp/src_public_schema.sql > /tmp/0009_body.sql
 *   node scripts/rewrite-inv-schema.mjs /tmp/src_public_schema.sql \
 *     -o supabase/migrations/0009_inventory_schema.sql
 *
 * ── 安全模型（為什麼是 inv 而不是 public）─────────────────────────────────
 * 目標專案的 PostgREST 只掛 public,graphql_public。把進銷存放進 inv 之後，
 * 瀏覽器**結構上**就連不到這些表 —— 不管拿到什麼 key、不管 RLS 怎麼設。
 * 這件事很重要，因為 vendors 有 48 欄，含身分證字號、統一編號、銀行帳戶。
 * 既然 inv 不對外，83 條 RLS policy 就沒有作用對象，一條都不搬。
 */

import { readFileSync, writeFileSync } from "node:fs";

// ── 設定 ────────────────────────────────────────────────────────────────────

const TARGET_SCHEMA = "inv";

/**
 * 這些 schema 前綴**不可以**被改寫成 inv。
 * 來源 SQL 裡真正會出現的是 auth.uid() / auth.users / pg_catalog.set_config，
 * 其餘幾個列在這裡是防禦性的：備份換版之後若冒出來，掃描器會看見它們，
 * 而不是默默把 storage.objects 改成 inv.objects。
 */
const PROTECTED_PREFIXES = [
  "auth.",
  "storage.",
  "extensions.",
  "pg_catalog.",
  "graphql",
  "realtime",
  "vault",
];

/** 目標專案不存在的角色 —— 對它們的 GRANT 會直接讓整個 migration 失敗。 */
const UNKNOWN_ROLE_RE = /^sandbox_exec/;

/** 不該擁有 inv 任何權限的角色。 */
const BROWSER_ROLES = new Set(["anon", "authenticated"]);

// ── 規則計數器（稽核輸出的骨架）────────────────────────────────────────────

const hits = new Map();
const bump = (rule, n = 1) => hits.set(rule, (hits.get(rule) ?? 0) + n);
const notes = [];

// ── SQL 切段器 ──────────────────────────────────────────────────────────────
/**
 * 把 dump 切成「一段一段」，每段是一個語句或一塊註解。
 * 必須自己寫是因為 pg_dump 的函式本體用 $$ 包住，裡面有分號 —— 直接 split(';')
 * 會把每個函式切碎。這裡處理四種「分號不算分號」的情境：
 *   1. -- 行註解      2. '單引號字串'（含 '' 逃脫）
 *   3. "識別字"       4. $tag$ 錢字號引用 $tag$
 */
function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // 行註解
    if (ch === "-" && sql[i + 1] === "-") {
      const eol = sql.indexOf("\n", i);
      const end = eol === -1 ? n : eol + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    // 單引號字串
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j += 1;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // 雙引號識別字
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (sql[j] === '"') break;
        j += 1;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // $tag$ … $tag$
    if (ch === "$") {
      const m = /^\$[A-Za-z_-￿][A-Za-z0-9_-￿]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        buf += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === ";") {
      buf += ch;
      out.push(buf);
      buf = "";
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  if (buf.trim()) out.push(buf);
  return out;
}

/** 去掉前導註解與空白，拿到語句本身（用來分類）。 */
function bareStatement(chunk) {
  return chunk
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .trim();
}

/** 拿到語句前面那一段 pg_dump 的 `-- Name: … Type: …` 註解。 */
function leadingComment(chunk) {
  return chunk
    .split("\n")
    .filter((l) => l.trimStart().startsWith("--"))
    .join("\n");
}

// ── 規則 ────────────────────────────────────────────────────────────────────

/** R1：public. → inv.（受保護前綴不動）*/
function rewriteSchemaQualifier(text) {
  let count = 0;
  const rewritten = text.replace(/\bpublic\./g, () => {
    count += 1;
    return `${TARGET_SCHEMA}.`;
  });
  if (count) bump("R1 public. → inv.", count);
  return rewritten;
}

/** R2：函式的 SET search_path TO 'public' → TO 'inv', 'public' */
function rewriteSearchPath(text) {
  let count = 0;
  const rewritten = text.replace(/SET search_path TO '(?:public|inv)'/g, () => {
    count += 1;
    return `SET search_path TO '${TARGET_SCHEMA}', 'public'`;
  });
  if (count) bump("R2 SET search_path → 'inv', 'public'", count);
  return rewritten;
}

/** R9：pg_dump 標頭註解 `Schema: public` → `Schema: inv` */
function rewriteHeaderComment(text) {
  let count = 0;
  const rewritten = text.replace(/(^|\n)(--.*?)Schema: public/g, (_m, a, b) => {
    count += 1;
    return `${a}${b}Schema: ${TARGET_SCHEMA}`;
  });
  if (count) bump("R9 註解標頭 Schema: public → inv", count);
  return rewritten;
}

/** 掃描受保護前綴，證明它們沒有被動到。 */
function scanProtected(text) {
  for (const prefix of PROTECTED_PREFIXES) {
    const re = new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const n = (text.match(re) ?? []).length;
    if (n > 0) bump(`R0 保留不改：${prefix}`, n);
  }
}

/**
 * R7a：generate_stock_adjustment_number() 改成條件式。
 * 原版無條件覆寫 NEW.adjustment_number，而它掛在 BEFORE INSERT —— 上線後
 * 只要有人 UPDATE 一張已存在的調整單，就會被重新產號、序號白白跳號。
 */
function patchStockAdjustmentNumber(text) {
  const before = `  v_date_str := to_char(COALESCE(NEW.adjustment_date, CURRENT_DATE), 'YYYYMMDD');
  v_seq := nextval('${TARGET_SCHEMA}.stock_adjustment_seq');
  v_number := 'ADJ-' || v_date_str || '-' || LPAD(v_seq::text, 3, '0');
  NEW.adjustment_number := v_number;
  RETURN NEW;`;
  const after = `  -- 只在單號還沒有值的時候才產號。原版是無條件覆寫，配上 BEFORE INSERT
  -- 的觸發時機，任何一次 UPDATE 都會重新產號並讓序號跳號。
  IF NEW.adjustment_number IS NULL OR NEW.adjustment_number = '' THEN
    v_date_str := to_char(COALESCE(NEW.adjustment_date, CURRENT_DATE), 'YYYYMMDD');
    v_seq := nextval('${TARGET_SCHEMA}.stock_adjustment_seq');
    v_number := 'ADJ-' || v_date_str || '-' || LPAD(v_seq::text, 3, '0');
    NEW.adjustment_number := v_number;
  END IF;
  RETURN NEW;`;
  if (!text.includes(before)) return { text, ok: false };
  bump("R7 單號產生器改條件式（generate_stock_adjustment_number）");
  return { text: text.replace(before, after), ok: true };
}

/** R7b：generate_vendor_return_number() 同上。 */
function patchVendorReturnNumber(text) {
  const before = `  v_date_str := to_char(COALESCE(NEW.return_date, CURRENT_DATE), 'YYYYMMDD');
  v_seq := nextval('${TARGET_SCHEMA}.vendor_return_seq');
  NEW.return_number := 'VR-' || v_date_str || '-' || LPAD(v_seq::text, 3, '0');
  RETURN NEW;`;
  const after = `  -- 同 generate_stock_adjustment_number()：只在沒有單號時才產號。
  IF NEW.return_number IS NULL OR NEW.return_number = '' THEN
    v_date_str := to_char(COALESCE(NEW.return_date, CURRENT_DATE), 'YYYYMMDD');
    v_seq := nextval('${TARGET_SCHEMA}.vendor_return_seq');
    NEW.return_number := 'VR-' || v_date_str || '-' || LPAD(v_seq::text, 3, '0');
  END IF;
  RETURN NEW;`;
  if (!text.includes(before)) return { text, ok: false };
  bump("R7 單號產生器改條件式（generate_vendor_return_number）");
  return { text: text.replace(before, after), ok: true };
}

/** update_stock_on_sale() 裡的死碼 —— 保留原樣，但要留註解說明。 */
function annotateSecondhandDeadCode(text) {
  const anchor = `  IF v_product_type IS NULL OR v_product_type = 'secondhand' THEN
    RETURN NEW;
  END IF;`;
  const replacement = `  -- ⚠️ 死碼，刻意保留（2026-08 搬遷）：products.product_type 的 CHECK 只允許
  -- outright/consignment/rental，所以 = 'secondhand' 這個分支永遠不成立。
  -- 但 sales.is_secondhand 欄位是活的（來源前端 SecondhandSaleDialog.tsx 在用），
  -- 上面那段 IF NEW.is_secondhand = true 才是真正生效的二手判斷。
  -- 兩者的關係要等搬 Sales 模組時當面查清楚，這一期原樣保留、不改行為。
  IF v_product_type IS NULL OR v_product_type = 'secondhand' THEN
    RETURN NEW;
  END IF;`;
  if (!text.includes(anchor)) return { text, ok: false };
  bump("R8 死碼加註解（update_stock_on_sale 的 secondhand 分支）");
  return { text: text.replace(anchor, replacement), ok: true };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outFlag = args.indexOf("-o");
const outPath = outFlag === -1 ? null : args[outFlag + 1];
const inPath = args.find((a, i) => !a.startsWith("-") && i !== outFlag + 1);

if (!inPath) {
  console.error("用法：node scripts/rewrite-inv-schema.mjs <src_public_schema.sql> [-o out.sql]");
  process.exit(2);
}

const source = readFileSync(inPath, "utf8");
const chunks = splitStatements(source);
const kept = [];

let sawStockAdjNumberPatch = false;
let sawVendorReturnPatch = false;
let sawSecondhandNote = false;

for (const chunk of chunks) {
  const stmt = bareStatement(chunk);

  // ── R6：psql meta 指令與 pg_dump 的 session 前言 ──────────────────────
  // \restrict / \unrestrict 是 psql 專用，Management API 送過去會是語法錯誤。
  if (/^\\(un)?restrict\b/m.test(stmt) || stmt === "") {
    if (/^\\(un)?restrict\b/m.test(stmt)) bump("R6 移除 psql meta 指令（\\restrict）");
    continue;
  }
  if (/^SET\s+\w+\s*=/i.test(stmt) || /^SELECT pg_catalog\.set_config\(/i.test(stmt)) {
    bump("R6 移除 pg_dump session 前言（SET / set_config）");
    continue;
  }

  // ── R3：RLS policy 一條都不搬 ─────────────────────────────────────────
  if (/^CREATE POLICY/i.test(stmt)) {
    bump("R3 刪除 CREATE POLICY");
    continue;
  }

  // ── R4：權限語句 ───────────────────────────────────────────────────────
  // 全部丟掉，改用檔尾一塊寫死的 canonical grant。理由：來源的 GRANT 逐物件
  // 散落 217 條，其中還有目標專案根本不存在的 sandbox_exec_* 角色 —— 與其
  // 逐條篩，不如整批丟掉再重新授一次，「inv 只給 service_role」才好驗證。
  if (/^(GRANT|REVOKE)\b/i.test(stmt) || /^ALTER DEFAULT PRIVILEGES\b/i.test(stmt)) {
    const roles = [...stmt.matchAll(/\bTO\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    let labelled = false;
    for (const role of roles) {
      if (BROWSER_ROLES.has(role)) {
        bump(`R4 刪除權限語句 → ${role}`);
        labelled = true;
      } else if (UNKNOWN_ROLE_RE.test(role)) {
        bump("R4 刪除權限語句 → sandbox_exec*（目標專案無此角色）");
        labelled = true;
      } else {
        bump(`R4 刪除權限語句 → ${role}（改由檔尾 canonical grant 重授）`);
        labelled = true;
      }
    }
    if (!labelled) bump("R4 刪除權限語句 → 其他");
    continue;
  }

  // ── R5：handle_new_user 與 auth.users 上的 trigger ────────────────────
  // 目標的 0002_admin.sql 已經有同名函式與同名 trigger（建 role='customer'），
  // 而來源這一版會讓「第一個註冊的帳號」自動變成 admin。同名同表，不刪必炸。
  if (/^CREATE (OR REPLACE )?FUNCTION\s+public\.handle_new_user\b/i.test(stmt)) {
    bump("R5 刪除來源 handle_new_user()（目標 0002 已有同名函式）");
    continue;
  }
  if (/^CREATE TRIGGER\s+on_auth_user_created\b/i.test(stmt)) {
    bump("R5 刪除 auth.users 上的 on_auth_user_created trigger");
    continue;
  }
  if (/handle_new_user/i.test(stmt) && /^COMMENT ON/i.test(stmt)) {
    bump("R5 刪除 handle_new_user 的附屬語句");
    continue;
  }

  // ── R6b：inventory_adjustments 的重複 trigger ─────────────────────────
  // 來源有兩個 trigger 綁同一個函式：
  //   trigger_update_stock_on_adjustment  AFTER  INSERT
  //   update_stock_on_adjustment          BEFORE INSERT OR UPDATE
  // 函式在 TG_OP='INSERT' 時會加減庫存，所以 INSERT 一筆會被扣加兩次。
  // 這是既有 bug；搬家是零成本修掉它的唯一時機。只留 BEFORE 那一個
  //（它同時涵蓋 UPDATE 時 pending→approved 的補扣，功能是前者的超集）。
  if (/^CREATE TRIGGER\s+trigger_update_stock_on_adjustment\b/i.test(stmt)) {
    bump("R6b 刪除 inventory_adjustments 的重複 trigger（AFTER INSERT）");
    continue;
  }

  // ── 改寫 ───────────────────────────────────────────────────────────────
  let text = chunk;
  scanProtected(text);
  text = rewriteHeaderComment(text);
  text = rewriteSchemaQualifier(text);
  text = rewriteSearchPath(text);

  if (/generate_stock_adjustment_number/i.test(stmt)) {
    const r = patchStockAdjustmentNumber(text);
    text = r.text;
    sawStockAdjNumberPatch ||= r.ok;
  }
  if (/generate_vendor_return_number/i.test(stmt)) {
    const r = patchVendorReturnNumber(text);
    text = r.text;
    sawVendorReturnPatch ||= r.ok;
  }
  if (/^CREATE FUNCTION\s+inv\.update_stock_on_sale\b/i.test(bareStatement(text))) {
    const r = annotateSecondhandDeadCode(text);
    text = r.text;
    sawSecondhandNote ||= r.ok;
  }

  kept.push(text.replace(/^\n+/, ""));
  void leadingComment;
}

// ── 完整性檢查：規則沒命中 = 來源變了，不是「大概沒事」 ───────────────────

const problems = [];
if (!sawStockAdjNumberPatch) problems.push("generate_stock_adjustment_number() 的條件式改寫沒命中");
if (!sawVendorReturnPatch) problems.push("generate_vendor_return_number() 的條件式改寫沒命中");
if (!sawSecondhandNote) problems.push("update_stock_on_sale() 的 secondhand 死碼註解沒命中");
if ((hits.get("R3 刪除 CREATE POLICY") ?? 0) === 0) problems.push("一條 CREATE POLICY 都沒刪到");
if ((hits.get("R5 刪除來源 handle_new_user()（目標 0002 已有同名函式）") ?? 0) === 0) {
  problems.push("沒刪到來源的 handle_new_user()");
}
if ((hits.get("R6b 刪除 inventory_adjustments 的重複 trigger（AFTER INSERT）") ?? 0) === 0) {
  problems.push("沒刪到 inventory_adjustments 的重複 trigger");
}

// on_auth_user_created 掛在 auth.users 上，pg_restore --schema=public 天生就
// 不會把它 dump 出來 —— 所以這條規則命中 0 是**預期的**，不是漏掉。
if ((hits.get("R5 刪除 auth.users 上的 on_auth_user_created trigger") ?? 0) === 0) {
  notes.push(
    "on_auth_user_created 命中 0 次：它掛在 auth.users 上，--schema=public 的輸出" +
      "結構上就不含它。目標的 0002_admin.sql:82 那一個（建 role='customer'）維持不動。",
  );
}

// ── 產出 ────────────────────────────────────────────────────────────────────

const header = `-- 0009_inventory_schema.sql —— 進銷存 schema（inv）
--
-- ⚠️ 這個檔案是產生出來的，不要手改。改法是改 scripts/rewrite-inv-schema.mjs
-- 再重跑：
--   pg_restore --schema-only --schema=public --no-owner -f /tmp/src.sql <備份>
--   node scripts/rewrite-inv-schema.mjs /tmp/src.sql -o supabase/migrations/0009_inventory_schema.sql
--
-- 來源：小時光書店進銷存（Lovable / Supabase 專案 qbxonowiwatriqrfflkr）
--       備份 bookstock_260815.backup，PostgreSQL 17.6，21 張表 2,864 筆
--
-- ── 為什麼是 inv，不是 public ────────────────────────────────────────────
-- 這個專案的 PostgREST 只掛 db_schema = "public,graphql_public"。放進 inv 之後
-- 瀏覽器**結構上**就打不到進銷存的表 —— 不管拿到哪把 key、不管 RLS 怎麼設，
-- PostgREST 根本不會把 inv 掛出去。這件事之所以要緊，是因為 inv.vendors 有 48 欄，
-- 裡面有身分證字號、統一編號、銀行帳戶。
--
-- 由此推出這個檔案的三個刻意選擇：
--   1. 來源的 83 條 RLS policy 一條都不搬 —— inv 不對外，policy 沒有作用對象。
--   2. anon / authenticated 對 inv 零 grant，連 USAGE ON SCHEMA 都沒有。
--   3. 每張表仍然 ENABLE ROW LEVEL SECURITY 且零 policy。這不是多餘：萬一
--      哪天有人手滑把 inv 加進 db_schema，RLS 預設拒絕會是第二道門。
--      （與 0002_admin.sql:56 對 public.profiles 的做法一致。）
--
-- ── 相對來源的三處行為修正（都在改寫腳本裡，有註解）────────────────────
--   * inventory_adjustments 只留一個 trigger（來源兩個綁同一個函式，INSERT 會
--     重複扣加庫存兩次）
--   * generate_stock_adjustment_number() / generate_vendor_return_number()
--     改成「沒有單號才產號」（來源無條件覆寫，每次 UPDATE 都會跳號）
--   * update_stock_on_sale() 的 secondhand 死碼原樣保留，只加註解
--
-- 前一個 migration：0008_invoice_cron.sql。既有 0001–0008 一律不動。

begin;

-- LANGUAGE sql 的函式在 CREATE 時會被驗證，而 pg_dump 把函式排在資料表前面，
-- 所以 is_admin() / has_permission() 這幾支會參照到還沒建立的 inv.profiles。
-- pg_dump 自己也是靠這一行過關的。
set check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- 0. schema 與權限地基
-- ---------------------------------------------------------------------------
create schema if not exists ${TARGET_SCHEMA};

comment on schema ${TARGET_SCHEMA} is
  '小時光書店進銷存（2026-08 從 Lovable 專案搬入）。刻意不在 PostgREST 的 db_schema 裡，瀏覽器結構上打不到。只有 service_role 進得來。';

-- 先關門再蓋房子：後面所有物件都在門關著的情況下建立。
revoke all on schema ${TARGET_SCHEMA} from anon, authenticated;
revoke all on schema ${TARGET_SCHEMA} from public;
grant usage on schema ${TARGET_SCHEMA} to service_role;

`;

const footer = `

-- ---------------------------------------------------------------------------
-- 99. canonical grant —— inv 裡的每一個物件都只授給 service_role
-- ---------------------------------------------------------------------------
-- 來源那 217 條逐物件 GRANT 全部丟掉了（其中還有目標專案不存在的
-- sandbox_exec_* 角色）。改成整批授權有兩個好處：不會漏授，而且
-- 「anon/authenticated 對 inv 有幾筆權限」這個問題可以用一句 SQL 驗證。

grant all on all tables in schema ${TARGET_SCHEMA} to service_role;
grant all on all sequences in schema ${TARGET_SCHEMA} to service_role;
grant execute on all functions in schema ${TARGET_SCHEMA} to service_role;

-- PostgreSQL 建立函式時預設把 EXECUTE 授給 PUBLIC。inv 裡有 20 支
-- SECURITY DEFINER 函式，即使沒有 schema USAGE 就叫不到，還是收掉比較乾淨。
revoke execute on all functions in schema ${TARGET_SCHEMA} from public;
revoke all on all tables in schema ${TARGET_SCHEMA} from anon, authenticated;
revoke all on all sequences in schema ${TARGET_SCHEMA} from anon, authenticated;

-- 之後新增的物件也照這個規矩走。
alter default privileges in schema ${TARGET_SCHEMA} grant all on tables to service_role;
alter default privileges in schema ${TARGET_SCHEMA} grant all on sequences to service_role;
alter default privileges in schema ${TARGET_SCHEMA} grant execute on functions to service_role;

commit;
`;

const body = kept
  .join("\n")
  .replace(/\n{4,}/g, "\n\n\n")
  .trim();
const output = `${header}${body}\n${footer}`;

if (outPath) {
  writeFileSync(outPath, output, "utf8");
} else {
  process.stdout.write(output);
}

// ── 稽核輸出（永遠印到 stderr，才不會汙染 stdout 的 SQL）───────────────────

const log = (s) => process.stderr.write(`${s}\n`);
log("");
log("── 改寫稽核 ────────────────────────────────────────");
log(`來源：${inPath}`);
log(`輸入語句／註解區塊：${chunks.length}`);
log(`輸出保留：${kept.length}`);
log("");
const order = [...hits.keys()].sort();
for (const rule of order) log(`  ${String(hits.get(rule)).padStart(4)} × ${rule}`);
log("");
for (const note of notes) log(`  註：${note}`);
if (notes.length) log("");

if (problems.length) {
  log("\x1b[31m✗ 改寫規則沒有全部命中 —— 來源可能換版了：\x1b[0m");
  for (const p of problems) log(`\x1b[31m    • ${p}\x1b[0m`);
  process.exit(1);
}

// 產出物自我檢查：這幾條是「安全模型有沒有被破壞」的直接證據。
// 只看**可執行的 SQL**，註解不算 —— 檔尾那段說明文字裡就有 sandbox_exec 這個詞。
const executable = output
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const leaks = [];
if (/CREATE POLICY/i.test(executable)) leaks.push("產出物裡還有 CREATE POLICY");
if (/\bTO\s+(anon|authenticated)\b/i.test(executable)) {
  leaks.push("產出物裡還有給 anon/authenticated 的 GRANT");
}
const strayPublic = [
  ...executable
    .split("\n")
    // 檔尾 canonical grant 裡的 `from public` 是 PUBLIC 這個偽角色，不是 schema。
    .filter((l) => !/from public;/.test(l))
    .join("\n")
    .matchAll(/\bpublic\.\w+/g),
].map((m) => m[0]);
if (strayPublic.length) {
  leaks.push(`產出物裡還有 public. 參照：${[...new Set(strayPublic)].join(", ")}`);
}
if (/sandbox_exec/.test(executable)) leaks.push("產出物裡還有 sandbox_exec* 角色");

if (leaks.length) {
  log("\x1b[31m✗ 產出物自我檢查失敗：\x1b[0m");
  for (const l of leaks) log(`\x1b[31m    • ${l}\x1b[0m`);
  process.exit(1);
}

log("\x1b[32m✓ 改寫完成，產出物自我檢查通過\x1b[0m");
log(`   CREATE POLICY：0    給 anon/authenticated 的 GRANT：0    殘留 public. 參照：0`);
log("");
