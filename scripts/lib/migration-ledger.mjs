/**
 * supabase/migrations 的**共用帳本**，以及三條建立在它上面的斷言。
 *
 * ═══ 為什麼有這個檔案 ═══════════════════════════════════════════════════════
 *
 * 在這之前，「migration 盤點」散在八支自檢裡，長成三種形狀：
 *
 *   (a) 純數量快照   check("migrations 共 27 支", migrations.length, 27)   ×3 支
 *   (b) 位置快照     check("0023 是最後一支", migrations[22], "0023_…")     ×3 支
 *   (c) 存在性檢查   migFiles.some((f) => f.startsWith("0024_"))            ×一堆
 *
 * 每加一支 migration，(a) 會在三個地方轉紅，作者去把 27 改成 28。那個「被叫回來」
 * 是**特性不是 bug**：它逼作者對每一個受保護的區域回答一次「0028 有沒有動到我
 * 這一區」。所以這個檔案的目的**不是**把它變成「改一個數字、八支全綠」——那會
 * 把強迫機制拆掉，而且沒有人會發現它被拆掉了。
 *
 * ── 舊機制真正壞在哪裡（這是動手改的理由）────────────────────────────────
 *
 * 1. **(b) 那三條在說謊，而且它們根本沒在強迫任何人。**
 *    `migrations[22] === "0023_fix_cron_guard.sql"` 斷言的是「0023 在第 23 個
 *    位置」。加了 0028 之後 0023 還是在第 23 個位置，所以這條**不會轉紅**。但它
 *    的標籤寫著「0023 是最後一支」，於是測試輸出會印出綠色的
 *    「✓ 0023 是最後一支」——而真正的最後一支是 0027。它們既沒有守門，還在騙
 *    讀者。這比維護負擔嚴重得多。
 *
 * 2. **作者的答覆寫在註解裡，沒有任何東西驗證它。**
 *    每一支自檢的 [1] 上面都有一大段散文：「0027 加了七個 jsonb 欄位、建
 *    event_blocks…它對 event_sessions 那一段是逐字照抄 0026 的，所以下面每一條
 *    斷言原樣成立」。那段散文才是真正的表態，但它是註解。作者少寫一句、寫錯一句、
 *    或整段複製上一期的，沒有任何機制會發現。
 *
 * ── 這個檔案怎麼在**消掉重複**的同時**把強迫機制加強** ──────────────────
 *
 * 把「回答」從八個「你沒動到我吧？」（淺、重複、寫在註解裡）換成一個
 * 「我動了什麼？」（深、只答一次、被機器驗證），再由機器把它路由到該看的自檢：
 *
 *   1. `MIGRATION_LEDGER` —— 每一支 migration 一列，附一行「它動了什麼」與一組
 *      **區域標籤**。這是作者唯一要回答的地方。新增 migration 而不補這一列，
 *      `assertLedgerMatchesDisk()` 就轉紅（在每一支引用它的自檢裡都轉紅）。
 *
 *   2. `assertLedgerDeclarationsHonest()` —— **反少報偵測器**。每個區域帶一組
 *      識別字（表名／函式名）。掃 migration 的 SQL（剝掉註解），只要提到某區域的
 *      識別字、而作者沒有標那個區域，就轉紅。所以「0028 我什麼都沒動」這種偷懶
 *      答案騙不過去。多標是安全的（只會叫更多支自檢回來看），少標會被抓。
 *      **這一條是整個設計的承重牆**：沒有它，帳本就只是一個沒人驗的宣告。
 *
 *   3. `assertMigrationDependencies()` —— 每支自檢宣告「我依賴哪幾個區域」與
 *      「我審到哪一支」。帳本裡只要出現一支「在我審過的之後、而且動到我依賴的
 *      區域」的 migration，那支自檢就轉紅，訊息直接寫出是哪一支動到哪一區。
 *      作者讀完那一區的斷言，把 reviewedThrough 往前推一格。
 *
 * ── 所以「強迫表態」保住了嗎 ─────────────────────────────────────────────
 *
 * 保住了，而且比原來強。逐項對照：
 *
 *   · **整片板子還是會亮紅。** 新增一支 migration 而沒補帳本 → 每一支引用
 *     `assertLedgerMatchesDisk()` 的自檢**全部轉紅**（跟以前一樣多），只是修法
 *     從「在 N 個地方各改一個數字」變成「在一個地方回答一次」。**紅燈的數量沒
 *     有減少，減少的只有機械性的編輯次數。**
 *   · **答覆從註解變成被驗證的資料。** 以前作者寫「0027 沒碰 email_outbox」是
 *     散文；現在他寫 `touches: [...]`，而偵測器會拿 SQL 對答案。
 *   · **問題從「是非題」變成「問答題」。** 以前八次「你沒動到我吧？」預設答案
 *     是「對，沒動到」，複製上一期的註解就過關；現在一次「你動了什麼？」沒有
 *     預設答案，而且答錯會被 SQL 打臉。
 *   · **路由是機器做的，所以不會漏。** 以前作者要自己記得「roster-csv 也在乎
 *     event_registrations」；漏掉一支就沒人看。現在只要標了
 *     `event_registrations`，所有依賴它的自檢自動轉紅。
 *
 * 唯一被放掉的是「動到完全無關的區域時，那幾支自檢也要作者去看一眼」。那個是
 * 真正的雜訊：作者去看，然後把數字改掉，沒有產生任何資訊。
 *
 * ── 這個檔案不做的事 ─────────────────────────────────────────────────────
 *
 * `touches` **必須是寫死在下面的字面值**，不可以改成「跑的時候從 SQL 算出來」。
 * 一算出來就沒有作者的宣告了，偵測器會變成拿自己的輸出跟自己比對——這個 repo
 * 出過六次的假陽性裡就有這一種（「測試自己先把要驗的東西修好了再驗」）。
 * 偵測器的角色是**拿 SQL 檢查作者寫下的字面值**，不是產生它。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 讀 migration 檔。**讀不到就丟例外**，不回空字串。
 * 理由與各支自檢的 readFile 相同，見 run-selftests.mjs 的「守門 4」：回空字串會讓
 * 所有「確認裡面沒有 X」的否定斷言靜默通過。
 */
const readSql = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(
      `migration-ledger 讀不到檔案：${p}（${err.code ?? err.message}）。` +
        "這裡刻意不回空字串 —— 回空字串會讓底下的識別字掃描永遠掃不到東西，" +
        "於是「這支 migration 沒動到任何區域」變成一個靜默通過的結論。",
    );
  }
};

/**
 * 區域。**每一個都必須有識別字**（`assertLedgerDeclarationsHonest` 會檢查這件事），
 * 因為只有帶識別字的區域才驗得起來——沒有識別字的區域等於「相信作者說的」，而這個
 * 檔案存在的理由就是不要再相信沒被驗證的宣告。
 *
 * 識別字的比對規則：
 *   · 在 migration 的 SQL 上比對，**只剝掉註解，不剝字串**。字串裡出現的識別字是
 *     算數的 —— 例如 0021 的 pii_access_log CHECK 裡寫著 `'inv.vendors'`，那代表
 *     這支 migration 確實在治理廠商 PII 的存取，不是巧合。
 *   · 前後帶 word boundary，所以 `orders` 不會誤中 `order_items`、`inv.` 不會誤中
 *     `invoice`。
 *   · 多標是安全的（叫更多支自檢回來看），少標會被偵測器抓到。設計上就偏向多標。
 *
 * `witness` 是**這一區的守門人**。它是一支「毫無疑問屬於這個區域」的 migration，
 * 由人手寫下來；`assertLedgerDeclarationsHonest()` 會確認這一區的識別字**真的**在
 * 那支檔案裡對得到。
 *
 * 為什麼需要它：識別字被改窄（例如把 "email_outbox" 打錯成 "email_outbx"，或有人
 * 為了消掉一個誤判把整組識別字砍到只剩一個罕見的字）之後，偵測器對這一區就永遠
 * 掃不到東西 —— 於是「這支 migration 沒碰 email_outbox」變成一個**靜默成立**的
 * 結論，而所有依賴 email_outbox 的自檢從此再也不會被叫回來。畫面上全綠。
 * 這正是這個 repo 出過六次的假陽性形狀（「斷言釘死單一路徑，程式碼搬家後靜默
 * 失去覆蓋」）的變體，所以要明著擋：只要識別字對不到自己的 witness，就轉紅。
 */
export const AREAS = Object.freeze({
  admin_auth: {
    witness: "0002_admin.sql",
    label: "後台身分與權限",
    identifiers: ["staff_permissions", "is_admin", "profiles"],
  },
  storage: {
    witness: "0003_storage_site_images.sql",
    label: "Storage bucket 與 policy",
    identifiers: ["storage.buckets", "site-images"],
  },
  cms: {
    witness: "0001_init.sql",
    label: "站台內容（頁面／展覽／刊物／講者）",
    identifiers: ["pages", "site_settings", "exhibitions", "publications", "artists"],
  },
  orders_payments: {
    witness: "0005_commerce_orders.sql",
    label: "訂單、付款與 webhook",
    identifiers: [
      "orders",
      "payments",
      "webhook_events",
      "payment_alerts",
      "order_post_payment_log",
    ],
  },
  order_expiry: {
    witness: "0006_order_expiry.sql",
    label: "未付款訂單過期與 order_items",
    identifiers: ["expire_unpaid_orders", "order_items"],
  },
  products_availability: {
    witness: "0004_commerce_products.sql",
    label: "商品主檔與可售量",
    identifiers: ["products", "product_availability"],
  },
  session_seats: {
    witness: "0020_event_sessions_registrations.sql",
    label: "場次名額與座位計數（0020 之前掛在 products，之後掛在 event_sessions）",
    identifiers: ["event_sessions", "reserve_session_seat", "release_session_seat", "seats_taken"],
  },
  event_registrations: {
    witness: "0020_event_sessions_registrations.sql",
    label: "逐位參加者",
    identifiers: ["event_registrations"],
  },
  roster_pii: {
    witness: "0021_roster_pii.sql",
    label: "名單遮罩、明文出口與 PII 存取紀錄",
    identifiers: ["admin_event_roster", "pii_access_log", "on_roster"],
  },
  email_outbox: {
    witness: "0022_email_outbox_notify.sql",
    label: "交易信 outbox 與通知函式",
    identifiers: [
      "email_outbox",
      "email_copy",
      "claim_order_notify",
      "notify_backlog",
      "dispatch_notify_task",
      "enqueue_registration_emails",
      "sessions_due_for_reminder",
    ],
  },
  cron_jobs: {
    witness: "0008_invoice_cron.sql",
    label: "pg_cron 排程",
    identifiers: ["cron.schedule", "cron.job", "to_regproc", "to_regprocedure"],
  },
  invoice: {
    witness: "0007_invoice_issue.sql",
    label: "電子發票",
    identifiers: ["invoices", "invoice_backlog", "claim_invoice_issue", "dispatch_invoice_task"],
  },
  inventory: {
    witness: "0009_inventory_schema.sql",
    label: "進銷存（inv schema）",
    identifiers: [
      "inv.",
      "inv_admin_products",
      "inventory_adjustments",
      "combo_set_items",
      "vendors",
    ],
  },
  events_shape: {
    witness: "0001_init.sql",
    label: "public.events 的欄位形狀與活動頁組裝",
    identifiers: ["public.events", "event_blocks", "admin_upsert_event_with_session", "speaker_id"],
  },
  localized_list: {
    witness: "0027_event_blocks.sql",
    label: "三語 jsonb 的形狀守衛（is_localized / is_localized_list）",
    // ⚠️ 這一區故意跟 events_shape 分開。三語形狀不是 events 的專利 —— 0004 的商品、
    //    0015 的刊物、0020 的場次都用同一個 is_localized() 守自己的 jsonb 欄位。
    //    掛進 events_shape 會逼著那幾支 migration 標上「碰了 events 的欄位形狀」，
    //    那是假的；分開之後兩邊的標籤都說實話。
    identifiers: ["is_localized", "is_localized_list"],
  },
  pos: {
    witness: "0014_pos_counter.sql",
    label: "門市 POS 櫃檯",
    identifiers: ["pos_checkout", "inv_pos_products", "inv_pos_sales", "inv_pos_payment_methods"],
  },
});

/**
 * 帳本。**一支 migration 一列，順序就是磁碟上的順序。**
 *
 * ⚠️ 新增 migration 時要做的唯一一件事：在最後面加一列，寫下
 *    `note`（一行「它動了什麼」）與 `touches`（它碰到的區域）。
 *    · 少寫一列 → `assertLedgerMatchesDisk()` 在每一支引用它的自檢轉紅。
 *    · `touches` 少標 → `assertLedgerDeclarationsHonest()` 轉紅並指名漏了哪一區。
 *    · 標到某支自檢依賴的區域 → 那支自檢轉紅，要你去重讀它的斷言。
 *
 * ⚠️ `touches` 是**作者的宣告**，不是掃描結果。不要改成執行時計算 —— 見檔頭最後
 *    一段。它可以（也應該）被偵測器打臉，但它必須先被人寫下來。
 */
export const MIGRATION_LEDGER = Object.freeze([
  {
    file: "0001_init.sql",
    note: "內容層初始 schema：pages / exhibitions / events / site_contents",
    touches: ["cms", "events_shape", "localized_list"],
  },
  {
    file: "0002_admin.sql",
    note: "/admin 後台需要的身分：profiles、role、is_admin()",
    touches: ["admin_auth"],
  },
  {
    file: "0003_storage_site_images.sql",
    note: "site-images Storage bucket 與它的 policy",
    touches: ["storage"],
  },
  {
    file: "0004_commerce_products.sql",
    note: "商品主檔；名額（capacity/seats_taken）當時掛在 products 上",
    touches: ["products_availability", "session_seats", "localized_list"],
  },
  {
    file: "0005_commerce_orders.sql",
    note: "訂單、付款、發票、物流四張表",
    touches: [
      "orders_payments",
      "order_expiry",
      "products_availability",
      "invoice",
      "localized_list",
    ],
  },
  {
    file: "0006_order_expiry.sql",
    note: "沒人付款就把庫存與名額還回去（expire_unpaid_orders）",
    touches: ["orders_payments", "order_expiry", "products_availability", "session_seats"],
  },
  {
    file: "0007_invoice_issue.sql",
    note: "開發票的 claim-then-act 鎖與 invoice_backlog",
    touches: ["orders_payments", "invoice"],
  },
  {
    file: "0008_invoice_cron.sql",
    note: "把 /api/tasks/invoices 掛上 pg_cron",
    touches: ["cron_jobs", "invoice"],
  },
  {
    file: "0009_inventory_schema.sql",
    note: "進銷存 21 張表搬進 inv schema（由 scripts/rewrite-inv-schema.mjs 產生）",
    touches: ["admin_auth", "products_availability", "inventory"],
  },
  {
    file: "0010_inventory_identity.sql",
    note: "進銷存的三層權限接到 public.profiles",
    touches: ["admin_auth"],
  },
  {
    file: "0011_inventory_single_source.sql",
    note: "庫存單一真相：網站賣 inv 的實體庫存；重寫 product_availability 與過期回補",
    touches: [
      "orders_payments",
      "order_expiry",
      "products_availability",
      "session_seats",
      "inventory",
    ],
  },
  {
    file: "0012_inventory_listing_admin_views.sql",
    note: "上架頁需要的兩個唯讀 view",
    touches: ["products_availability", "inventory"],
  },
  {
    file: "0013_tighten_availability_grants.sql",
    note: "收緊 product_availability 對 anon / authenticated 的 grant",
    touches: ["products_availability"],
  },
  {
    file: "0014_pos_counter.sql",
    note: "門市櫃檯走同一條庫存路徑",
    touches: ["admin_auth", "orders_payments", "products_availability", "inventory", "pos"],
  },
  {
    file: "0015_publications.sql",
    note: "地方刊物展的 126 本刊物（獨立一張表）",
    touches: ["cms", "products_availability", "localized_list"],
  },
  {
    file: "0016_inventory_products_admin.sql",
    note: "商品主檔的 CRUD 與審核搬進後台",
    touches: ["admin_auth", "products_availability", "inventory"],
  },
  {
    file: "0017_inventory_purchases_adjustments.sql",
    note: "進貨、盤點、在庫異動搬進後台",
    touches: ["admin_auth", "products_availability", "inventory"],
  },
  {
    file: "0018_inventory_combos_secondhand.sql",
    note: "套餐、二手書，以及 OCR 的私有 bucket",
    touches: ["admin_auth", "storage", "products_availability", "inventory"],
  },
  {
    file: "0019_vendors_pii_portal.sql",
    note: "廠商主檔、PII 治理（pii_access_log）、廠商自助入口",
    touches: ["admin_auth", "storage", "cms", "products_availability", "roster_pii", "inventory"],
  },
  {
    file: "0020_event_sessions_registrations.sql",
    note: "名額從 products 搬到 event_sessions，並開始收逐位參加者",
    touches: [
      "orders_payments",
      "order_expiry",
      "products_availability",
      "session_seats",
      "event_registrations",
      "cron_jobs",
      "inventory",
      "localized_list",
    ],
  },
  {
    file: "0021_roster_pii.sql",
    note: "名單的遮罩 view、兩個會留痕的明文出口；順手重寫 inv.mask_email",
    touches: [
      "admin_auth",
      "orders_payments",
      "session_seats",
      "event_registrations",
      "roster_pii",
      "inventory",
    ],
  },
  {
    file: "0022_email_outbox_notify.sql",
    note: "交易信 outbox 與付款成功後的通知（只讀 0020 建的東西）",
    touches: [
      "orders_payments",
      "session_seats",
      "event_registrations",
      "roster_pii",
      "email_outbox",
      "cron_jobs",
      "localized_list",
    ],
  },
  {
    file: "0023_fix_cron_guard.sql",
    note: "修好 to_regproc 讓排程靜默不建立的守衛，並補建 dispatch-notify-task 與發票排程",
    // ⚠️ email_outbox / invoice 這兩個標籤是被 assertLedgerDeclarationsHonest() 逼出來的：
    //    這一列原本只標了 orders_payments / order_expiry / cron_jobs，偵測器指出 0023
    //    的 SQL 裡有 dispatch_notify_task 與 dispatch_invoice_task。它是對的 —— 0023
    //    的整個目的就是把那兩支被守衛靜默跳過的排程補建回來，那當然算碰到了通知與
    //    發票。這一列就是這個機制實際運作的樣子。
    touches: ["orders_payments", "order_expiry", "cron_jobs", "email_outbox", "invoice"],
  },
  {
    file: "0024_blackcat_payment.sql",
    note: "黑貓 PAY 線上刷卡：orders.payment_url、payments.gateway_trans_id、payment_alerts()",
    touches: ["orders_payments"],
  },
  {
    file: "0025_event_speaker.sql",
    note: "活動掛講者：public.events.speaker_id → public.artists.id（一欄一索引）",
    touches: ["cms", "events_shape"],
  },
  {
    file: "0026_event_product_link.sql",
    note: "活動與商品的真連結：events.slug / image_key、admin_upsert_event_with_session()",
    touches: ["products_availability", "session_seats", "events_shape", "localized_list"],
  },
  {
    file: "0027_event_blocks.sql",
    note: "活動頁組裝器的資料層：events 七個 jsonb 欄位、event_blocks、reorder RPC",
    touches: ["products_availability", "session_seats", "events_shape", "localized_list"],
  },
  {
    file: "0028_free_order_settlement.sql",
    note: "免費訂單（total = 0）在結帳當下就結清：settle_free_order()、payment_method 認 'free'、invoice_backlog 加 total > 0",
    // ⚠️ order_expiry / event_registrations / session_seats 這三個標籤是**語意上的**，
    //    不是偵測器逼出來的：0028 一個字都沒有重寫 expire_unpaid_orders()，
    //    event_registrations 與 event_sessions 也完全沒被 ALTER。但它改掉的正是
    //    「哪些訂單會被 expire_unpaid_orders() 撈到」——免費訂單從此不再是 pending，
    //    於是它們的 order_items 不會被刪、event_registrations 不會 cascade 消失、
    //    座位不會被還回去。守著那三個區域的自檢（event-registration / notify /
    //    roster-csv）必須為此回來重讀一次，而唯一能叫得動它們的辦法就是在這裡標上。
    //    這是刻意的多標；帳本的設計說多標是安全的方向，這一列就是那個方向的用途。
    touches: ["orders_payments", "order_expiry", "event_registrations", "session_seats", "invoice"],
  },
]);

/** 磁碟上的 migration 檔名，排序過。空目錄 = 丟例外（那不是「沒有違規」）。 */
export function readMigrationFiles(migDir) {
  let files;
  try {
    files = readdirSync(migDir);
  } catch (err) {
    throw new Error(`migration-ledger 讀不到目錄：${migDir}（${err.code ?? err.message}）`);
  }
  const sql = files.filter((f) => f.endsWith(".sql")).sort();
  if (sql.length === 0) {
    throw new Error(
      `migration-ledger：${migDir} 底下一個 .sql 都沒有。` +
        "這裡刻意丟例外 —— 空清單會讓底下每一條「沒有任何一支違規」的斷言靜默通過。",
    );
  }
  return sql;
}

/** 識別字 → 正規表示式。頭尾是 word char 才補 boundary，所以 `inv.` 不會誤中 `invoice`。 */
function identifierRe(id) {
  const W = /[A-Za-z0-9_]/;
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pre = W.test(id[0]) ? "(?<![A-Za-z0-9_])" : "";
  const post = W.test(id[id.length - 1]) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(pre + esc + post, "i");
}

/**
 * 剝掉 SQL 註解。**不剝字串**——字串裡的識別字是算數的（見 AREAS 的說明）。
 * 剝註解是必要的：每一支 migration 的檔頭都在**說明**自己跟前幾支的關係，那些
 * 散文裡塞滿了別的區域的識別字，不剝的話每一支都會被標成碰了所有區域。
 */
function stripSqlComments(sql) {
  return (
    sql
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*--.*$/gm, " ")
      // `comment on <物件> is '…'` 的**字串內容**也算註解 —— 那是 SQL 自己的文件
      // 設施，裡面是散文。0016 就在一個 comment on view 的說明裡寫著「與
      // inv_pos_products 的差別是…」，那不是它碰了 POS。
      //
      // ⚠️ 只剝掉引號裡那一段，**保留前面的物件名**（`comment on function
      //    public.pos_checkout(...)` 這種才是真的訊號）。也只剝 comment on，別的
      //    字串一律保留 —— 0021 的 pii_access_log CHECK 裡寫著 'inv.vendors'，那是
      //    真的在治理廠商 PII，剝掉就漏了。
      .replace(/(\bcomment\s+on\b[\s\S]{0,400}?\bis\s+)'(?:[^']|'')*'/gi, "$1''")
  );
}

/** 剝過註解的 SQL，讀一次就記著（下面有好幾趟掃描要跑過全部 migration）。 */
const codeCache = new Map();
function migrationCode(migDir, file) {
  const key = join(migDir, file);
  if (!codeCache.has(key)) codeCache.set(key, stripSqlComments(readSql(key)));
  return codeCache.get(key);
}

/** 這支 migration 的 SQL 實際提到了哪些區域的識別字。 */
function areasMentionedIn(migDir, file) {
  const code = migrationCode(migDir, file);
  return Object.entries(AREAS)
    .filter(([, spec]) => spec.identifiers.some((id) => identifierRe(id).test(code)))
    .map(([area]) => area);
}

/**
 * 帳本與磁碟必須一一對應：同樣的檔、同樣的順序、編號從 0001 起連續不重複。
 *
 * 這一條取代了散在三支自檢裡的 `check("migrations 共 27 支", migrations.length, 27)`。
 * 它**比原來那條強**：原來只比對數量，這裡比對完整的有序檔名清單（少一支、多一支、
 * 改名、跳號、重號、順序不對，全都抓得到）。
 *
 * @param {(label: string, actual: unknown, expected: unknown) => void} check
 *   各支自檢自己的 check()。只用三個參數，所以四支自檢的不同簽名都吃得下。
 */
export function assertLedgerMatchesDisk(check, migDir) {
  const disk = readMigrationFiles(migDir);
  const ledger = MIGRATION_LEDGER.map((e) => e.file);

  const missing = ledger.filter((f) => !disk.includes(f));
  const extra = disk.filter((f) => !ledger.includes(f));
  if (extra.length > 0 || missing.length > 0) {
    console.log(
      `      → 帳本在 scripts/lib/migration-ledger.mjs 的 MIGRATION_LEDGER。\n` +
        `        新增 migration 時要在最後面補一列，寫下「它動了什麼」與它碰到的區域；\n` +
        `        少標區域會被 assertLedgerDeclarationsHonest() 抓到，標對了會自動把\n` +
        `        依賴那些區域的自檢叫回來重讀。這是這一整套唯一要人回答的地方。`,
    );
  }

  check(
    "磁碟上的 migration 全都在帳本裡（沒有人加了 migration 卻沒登記）",
    extra.join(",") || "（無）",
    "（無）",
  );
  check(
    "帳本裡的 migration 全都還在磁碟上（沒有人刪檔或改名）",
    missing.join(",") || "（無）",
    "（無）",
  );
  // ⚠️ 這裡刻意不寫成 `check(…, ledger.join(","), disk.join(","))`。那樣寫在失敗時
  //    會把兩份 28 個檔名的清單各印一次（兩行、每行一千多字），而真正的資訊只有
  //    「第幾個位置不一樣」。訊息要能行動，所以只報第一個對不上的位置。
  const len = Math.max(ledger.length, disk.length);
  let orderDiff = "（一致）";
  for (let i = 0; i < len; i += 1) {
    if (ledger[i] !== disk[i]) {
      orderDiff = `第 ${i + 1} 個位置：帳本是 ${ledger[i] ?? "（沒有了）"}，磁碟是 ${disk[i] ?? "（沒有了）"}`;
      break;
    }
  }
  check("帳本與磁碟的順序完全一致", orderDiff, "（一致）");

  const nums = disk.map((f) => Number(f.slice(0, 4)));
  check(
    "migration 編號從 0001 起連續、不重複",
    nums.join(","),
    nums.map((_, i) => i + 1).join(","),
  );

  const noteless = MIGRATION_LEDGER.filter((e) => !e.note || e.note.trim().length < 4);
  check(
    "帳本每一列都寫了「它動了什麼」",
    noteless.map((e) => e.file).join(",") || "（無）",
    "（無）",
  );

  const untagged = MIGRATION_LEDGER.filter(
    (e) => !Array.isArray(e.touches) || e.touches.length === 0,
  );
  check(
    "帳本每一列都至少標了一個區域",
    untagged.map((e) => e.file).join(",") || "（無）",
    "（無）",
  );

  const unknownArea = MIGRATION_LEDGER.flatMap((e) =>
    (e.touches ?? []).filter((a) => !(a in AREAS)).map((a) => `${e.file}:${a}`),
  );
  check(
    "帳本標的區域都是 AREAS 裡有定義的（擋打錯字）",
    unknownArea.join(",") || "（無）",
    "（無）",
  );
}

/**
 * **反少報偵測器。** 這是整套設計的承重牆。
 *
 * 帳本把「八支自檢各答一次『你沒動到我吧』」換成「作者在一個地方答一次『我動了
 * 什麼』」。這個交換只有在**那一個答案騙不過去**的時候才划算 —— 否則就是把八道
 * 淺的關卡換成一道可以隨便填的關卡，而且沒有人會發現。
 *
 * 所以：拿 migration 的 SQL 對答案。SQL 裡出現某區域的識別字、而作者沒標那個
 * 區域 → 紅。多標不罰（多標只會叫更多支自檢回來看，那是安全的方向）。
 */
export function assertLedgerDeclarationsHonest(check, migDir) {
  const disk = readMigrationFiles(migDir);

  // ── 先守偵測器自己 ──────────────────────────────────────────────────────
  // (1) 沒有識別字的區域是驗不起來的，等於「相信作者說的」。
  const unverifiable = Object.entries(AREAS)
    .filter(([, spec]) => !Array.isArray(spec.identifiers) || spec.identifiers.length === 0)
    .map(([area]) => area);
  check(
    "每個區域都有識別字（沒有識別字的區域驗不起來，等於沒在守）",
    unverifiable.join(",") || "（無）",
    "（無）",
  );

  // (2) **識別字真的對得到自己的 witness。** 光有識別字不夠 —— 識別字被改窄
  //     （打錯字、或為了消掉誤判被砍到剩一個罕見的字）之後，這一區的偵測就永遠
  //     空轉，而且是靜默的：從此每一支 migration 都被判定成「沒碰這一區」，依賴
  //     它的自檢再也不會被叫回來，畫面上全綠。witness 是人手寫的「這一支毫無疑問
  //     屬於這一區」，對不到就代表偵測器對這一區已經死了。
  const deadAreas = [];
  for (const [area, spec] of Object.entries(AREAS)) {
    if (!spec.witness) {
      deadAreas.push(`${area} 沒有指定 witness`);
      continue;
    }
    if (!disk.includes(spec.witness)) {
      deadAreas.push(`${area} 的 witness ${spec.witness} 不在磁碟上`);
      continue;
    }
    if (!areasMentionedIn(migDir, spec.witness).includes(area)) {
      deadAreas.push(`${area} 的識別字在 ${spec.witness} 裡一個都對不到`);
    }
  }
  if (deadAreas.length > 0) {
    console.log(
      "      → 這幾個區域的偵測已經空轉了：識別字對不到那支「毫無疑問屬於這一區」的\n" +
        "        migration，所以從現在起每一支新 migration 都會被判定成沒碰這一區，\n" +
        "        依賴它的自檢再也不會被叫回來。要修的是 AREAS 裡的識別字或 witness，\n" +
        "        不是把這條斷言拿掉。",
    );
  }
  check(
    "每個區域的識別字都對得到自己的 witness（擋偵測器空轉）",
    deadAreas.join("；") || "（無）",
    "（無）",
  );

  // (3) **每一個識別字都是活的。** witness 是區域層級的：只要同一區還有一個識別字
  //     活著，整區就過關 —— 所以「email_outbox 被打成 email_outbx，但同區的
  //     order_notify 還好好的」這種一半壞掉的情況騙得過 (2)。而它的後果是實打實的：
  //     日後一支只碰 email_outbox 這張表、沒碰 order_notify 的 migration 就掃不到了。
  //     這裡逐一驗：每個識別字都必須在 27 支 migration 裡至少對到一次。它們全都是
  //     這個 schema 裡真實存在的表名／函式名，對不到就代表被打錯或改窄了。
  const deadIdentifiers = [];
  for (const [area, spec] of Object.entries(AREAS)) {
    for (const id of spec.identifiers ?? []) {
      const re = identifierRe(id);
      if (!disk.some((f) => re.test(migrationCode(migDir, f)))) {
        deadIdentifiers.push(`${area}.${id}`);
      }
    }
  }
  if (deadIdentifiers.length > 0) {
    console.log(
      "      → 這幾個識別字在全部 migration 裡一次都沒對到。它們應該是這個 schema 裡\n" +
        "        真實存在的表名／函式名 —— 對不到就是被打錯或改窄了，而那會讓偵測器對\n" +
        "        那一塊靜默失去覆蓋。要新增一個目前還沒有人用到的識別字（例如先幫下一期\n" +
        "        的表名佔位），請連同它的第一支 migration 一起進來。",
    );
  }
  check(
    "每個識別字都至少對到一支 migration（擋識別字被改窄）",
    deadIdentifiers.join(",") || "（無）",
    "（無）",
  );

  const underDeclared = [];
  for (const entry of MIGRATION_LEDGER) {
    if (!disk.includes(entry.file)) continue; // 檔不在的情況由 assertLedgerMatchesDisk 報
    const mentioned = areasMentionedIn(migDir, entry.file);
    const declared = new Set(entry.touches ?? []);
    for (const area of mentioned) {
      if (!declared.has(area)) underDeclared.push(`${entry.file} 漏標 ${area}`);
    }
  }

  if (underDeclared.length > 0) {
    console.log(
      "      → SQL 裡提到了那個區域的識別字（表名／函式名），但帳本沒標。\n" +
        "        少標的代價是：依賴那個區域的自檢不會被叫回來，於是「有人動了我的東西」\n" +
        "        變成一件靜默發生的事。要嘛補上標籤，要嘛說明為什麼那個識別字出現在\n" +
        "        SQL 裡卻不算碰到（若真是誤判，改的是 AREAS 的識別字，不是拿掉標籤）。",
    );
  }
  check("帳本沒有少報：SQL 提到的區域都標了", underDeclared.join("；") || "（無）", "（無）");
}

/**
 * **強迫表態的那一條。** 每支自檢宣告：我依賴哪幾個區域、我審到哪一支。
 *
 * 帳本裡只要出現一支「排在 reviewedThrough 之後、而且動到 dependsOn 裡任何一個
 * 區域」的 migration，這條就轉紅，並指名是哪一支動到哪一區。作者去重讀那一段
 * 斷言，確認它們在新的 migration 之後仍然成立，然後把 reviewedThrough 推一格。
 *
 * 這一條**不會**因為「migration 總數變了」而轉紅 —— 那是 assertLedgerMatchesDisk
 * 的工作，而且那條已經在每一支自檢裡都會紅了。這一條回答的是更難的問題：
 * 「新來的那一支，動的是不是我在乎的東西。」
 *
 * ── ⚠️ dependsOn 少寫一個區域，是這整套設計唯一會靜默失去覆蓋的地方 ────────
 *
 * 底下的檢查擋得住：區域名打錯（比對 AREAS）、空清單、reviewedThrough 指到不存在
 * 的檔。但它擋不住「這支自檢其實也在乎 event_registrations，作者卻沒寫進 dependsOn」
 * —— 那樣的話動到 event_registrations 的 migration 不會叫它回來，而畫面是綠的。
 *
 * 沒有把這件事做成自動斷言，是刻意的：能想到的自動版本（掃自檢原始碼裡出現的區域
 * 識別字）誤判太多 —— PG 測試 harness 裡 `create table storage.buckets`、seed 資料裡
 * 的 `insert into public.products` 都會中，於是每一支都要配一份「這些不算」的例外
 * 清單，而那份清單就是下一個可以偷偷藏東西的地方。與其做一個帶逃生門的守衛，不如
 * 把程序寫下來。
 *
 * **改了自檢的斷言、或新開一支自檢時，用這個程序重新核對 dependsOn：**
 *
 *   1. 把自檢原始碼剝掉 JS 註解（保留字串 —— 斷言就寫在字串裡）。
 *   2. 對每一個 AREAS 的識別字做一次比對，列出「出現了但沒宣告」的區域。
 *   3. 逐個判斷：它出現在**斷言**裡（要宣告），還是只出現在**測試 harness／seed
 *      資料**裡（不用宣告 —— 那一類壞掉是會炸的，不是靜默的）。
 *
 * 目前這五支的清單就是這樣核出來的。第一版漏了好幾個（notify 漏了
 * event_registrations 與 roster_pii、roster-csv 漏了 inventory —— 0021 重寫了
 * inv.mask_email()、event-registration 漏了 orders_payments），跑一次上面的程序
 * 才抓出來。
 *
 * @param {(label, actual, expected) => void} check 各支自檢自己的 check()
 * @param {string} migDir supabase/migrations 的絕對路徑
 * @param {{suite: string, dependsOn: string[], reviewedThrough: string}} decl
 */
export function assertMigrationDependencies(check, migDir, decl) {
  const { suite, dependsOn, reviewedThrough } = decl;

  // ── 先守宣告本身 ────────────────────────────────────────────────────────
  // 打錯的區域名永遠比對不到任何 migration，於是這一支自檢從此再也不會被叫回來，
  // 而且畫面上是綠的。這正是這個 repo 出過六次的假陽性形狀，所以要明著擋。
  const badAreas = (dependsOn ?? []).filter((a) => !(a in AREAS));
  check(`${suite}：宣告依賴的區域都存在（擋打錯字）`, badAreas.join(",") || "（無）", "（無）");
  check(`${suite}：有宣告依賴的區域（空清單＝沒在守任何東西）`, (dependsOn ?? []).length > 0, true);

  const reviewedIdx = MIGRATION_LEDGER.findIndex((e) => e.file === reviewedThrough);
  check(
    `${suite}：reviewedThrough 指到帳本裡真的有的 migration`,
    reviewedIdx === -1 ? `找不到 ${reviewedThrough}` : "（有）",
    "（有）",
  );
  if (reviewedIdx === -1) return;

  // 順手確認那一支真的在磁碟上（帳本與磁碟脫節時，上面那條會另外報）。
  const disk = readMigrationFiles(migDir);
  check(
    `${suite}：審到的那一支 ${reviewedThrough} 還在磁碟上`,
    disk.includes(reviewedThrough),
    true,
  );

  // ── 正題 ────────────────────────────────────────────────────────────────
  const watched = new Set(dependsOn);
  const needsReview = MIGRATION_LEDGER.slice(reviewedIdx + 1)
    .map((e) => {
      const hit = (e.touches ?? []).filter((a) => watched.has(a));
      return hit.length > 0 ? `${e.file} 動到 ${hit.join("/")}` : null;
    })
    .filter(Boolean);

  if (needsReview.length > 0) {
    console.log(
      `      → 這幾支 migration 動到了 ${suite} 依賴的區域，但它宣告只審到 ${reviewedThrough}。\n` +
        "        請重讀這支自檢底下的斷言，確認它們在那幾支 migration 之後仍然成立\n" +
        "        （不是「看起來還在」，是逐條確認語意沒被改掉），然後把這支自檢的\n" +
        "        reviewedThrough 推到最新的那一支。若確認之後發現斷言真的失守，要修的\n" +
        "        是斷言，不是 reviewedThrough。",
    );
  }
  check(
    `${suite}：已審過的 ${reviewedThrough} 之後，沒有 migration 動到它依賴的區域`,
    needsReview.join("；") || "（無）",
    "（無）",
  );
}
