/**
 * 黑貓 PAY（統一客樂得多元支付平台）—— COCS 線上刷卡。
 * 規格：多元支付平台-WEBAPI介面規格 V1.28.2（頁碼標註都以那一份為準）。
 *
 * ── 這個檔案為什麼存在，而 payuni.ts 為什麼不動 ──────────────────────────
 * 這家店簽的是**黑貓 PAY（COCS）**的商店帳號，PAYUNi 只是它的收單銀行
 * （建單時的 `acquirer_type: "payuni"`）。兩者的協定完全沒有交集：
 *
 *              黑貓 PAY (COCS)                  PayUni 直連 UPP
 *   驗證       OAuth2 password → Bearer token   HashKey/HashIV 對稱金鑰
 *   加密       無（純 JSON over TLS）            AES-256-GCM EncryptInfo
 *   驗簽       MD5（而且有兩套，見下）            SHA256(HashKey+…+HashIV)
 *   建單       server 端建單 → 拿到付款**網址**    browser POST 表單才產生交易
 *
 * 所以 src/server/payuni.ts 那 475 行不是寫錯，只是這家店用不到 —— 哪天真的開
 * PayUni 直連還原封不動用得上。**不要動它，也不要動它的 49 個測試。**
 *
 * ── ⚠️ 這支檔案裡有「兩套完全不同的驗簽」，寫錯不會報錯，只會靜靜地驗不過 ──
 *
 *   1. 瀏覽器導回（success_url / 授權失敗轉址）的 `chk`   規格 P46 / P48
 *        MD5( hash_base + '$' + … )      ← **$** 分隔，**含 hash_base**
 *      而且**成功與失敗是兩條不同的公式**（9 個欄位 vs 6 個欄位），
 *      成功那條的欄位順序**不是欄位表的順序**：send_time 在 ret 之前。
 *
 *   2. APN 主動通知的 `checksum`                          規格 P89
 *        MD5( api_id + ':' + trans_id + ':' + amount + ':' + status + ':' + nonce )
 *                                        ← **:** 分隔，**不含 hash_base**，只有 5 欄
 *
 *   下面刻意寫成四個彼此獨立的函式，沒有「共用一個 helper 加旗標」的版本 ——
 *   那個旗標就是遲早會被傳錯的東西。
 *
 * ── 🔴 坑 1：APN 的 checksum 裡沒有任何祕密，所以它不是身分驗證 ──────────
 * 上面第 2 條那五個欄位**全部都在通知本體裡**：api_id 是我們的金流代號（會出現在
 * 每一封對帳信裡）、trans_id / amount / status / nonce 都是這則通知自己帶的。
 * 沒有 hash_base，沒有任何預先共享的密鑰。
 *
 * 也就是說：**任何人都能自己編一份「付款成功」的 JSON，自己算出一個合法的
 * checksum，POST 到我們的 APN 網址。** 客人知道自己的訂單編號，所以這不是理論
 * 上的攻擊。verifyApnChecksum() 的用途只有一個 —— 擋掉隨機亂打的雜訊。
 *
 * 真正的權威來源是 queryCocsOrder()（CocsOrderQuery，規格 P55）回來的
 * `process_code`。src/server/blackcat-webhook.ts 一定會回查，那不是效能取捨，
 * 是安全需求。
 *
 * ── 🔴 坑 2：金額要看 pay_amount，不是 amount ────────────────────────────
 * APN 的 `amount` 是**訂單/繳款單金額**（我們自己送出去的那個數字），
 * `payment_detail.pay_amount` 才是**實際授權金額**。而 checksum 算的是 `amount`。
 * 所以「checksum 通過」只證明這則通知沒被竄改，**完全不證明客人付對了錢**。
 *
 * 規格 P35 注意事項 2 是紅字：「APN 回檔時，有回拋實際繳款金額 pay_amount 給
 * 商戶，請技術要以實際繳款金額去判別這筆繳款應實收是否相符後才撥付商品給消費
 * 者。」apnPaidAmount() 就是為此存在，而且它**故意不 fallback 到 order_amount**
 * —— 見那個函式的註解，那個 fallback 會讓整個檢查變成恆真。
 *
 * ── 這個檔案不 import 任何專案模組 ──────────────────────────────────────
 * 只 import node:crypto，比照 payuni.ts / amego.ts。理由是
 * scripts/blackcat-selftest.mjs 要能直接把**產線的這一份**載進來驗，而不是驗一份
 * 長得很像的複本。任何 `@/…` 的 import 都會把 server-only 的東西拖進來，自檢就
 * 載不動了。siteUrl() 因此在這裡重寫一次，而不是從 payuni.ts 借。
 */
import { createHash, timingSafeEqual } from "node:crypto";

// ─────────────────────────────── 環境與設定 ───────────────────────────────

/**
 * 站台網址。APN 與導回網址都由它組出來。
 *
 * ⚠️ 與 payuni.ts 的 siteUrl() 是刻意的重複，見檔頭最後一段：這個模組不可以
 * import 任何專案模組。兩份要一起改。
 */
export function siteUrl(): string {
  return (process.env.SITE_URL ?? "http://localhost:8080").replace(/\/+$/, "");
}

/**
 * 是否打測試環境。預設 true（跟 payuni.ts 的 isSandbox() 同一個慣例：
 * 只有明確寫 "false" 才算正式），這樣忘了設變數的後果是「打到測試機付不了錢」，
 * 而不是「拿測試憑證對正式機收真的錢」。
 */
export function blackcatSandbox(): boolean {
  return process.env.BLACKCAT_SANDBOX !== "false";
}

/**
 * API BaseUrl（規格 P9）。
 *
 * ⚠️ 測試機的 BaseUrl **含一段路徑 `/app`**，不是只有 host：
 *      正式 https://cocs.4128888card.com.tw
 *      測試 https://test.4128888card.com.tw/app
 * 所以取 token 的完整網址分別是 `…/Token` 與 `…/app/Token`。把測試機當成
 * 「換個 host 就好」會 404，而 404 在這支 API 裡長得像「帳密錯誤」。
 */
export function blackcatBaseUrl(): string {
  const override = (process.env.BLACKCAT_BASE_URL ?? "").trim();
  if (override) return override.replace(/\/+$/, "");
  return blackcatSandbox()
    ? "https://test.4128888card.com.tw/app"
    : "https://cocs.4128888card.com.tw";
}

/** 契客代號（金流服務代號）。同時是取 token 的 username 與建單的 cust_id（規格 P10 明講是同一組）。 */
export function blackcatCustId(): string {
  return (process.env.BLACKCAT_CUST_ID ?? "").trim();
}

function apiPassword(): string {
  return (process.env.BLACKCAT_API_PASSWORD ?? "").trim();
}

function hashBase(): string {
  return (process.env.BLACKCAT_HASH_BASE ?? "").trim();
}

/**
 * 指定收單銀行（規格 P40）。esun / chinatrust / payuni 三選一。
 * 這家店合約開通的是統一金流 PAYUNi，所以預設 "payuni"。
 */
export function blackcatAcquirerType(): string {
  return (process.env.BLACKCAT_ACQUIRER_TYPE ?? "payuni").trim();
}

/**
 * 限定產品別（規格 P40 的 limit_product_id、對照表在 P96），以 "|" 分隔。
 *
 * 不設就是**允許所有產品別** —— 包含分期 3/6/9/12/18/24/30 期、銀聯卡、
 * Apple Pay / Google Pay / Samsung Pay。那不只是手續費的問題：
 * 規格 P66 與 P69 都明寫「信用卡分期付款及統一金流銀聯卡，僅能全額請退款」，
 * 也就是**只要客人選了分期，這筆訂單之後就不能部分退款**。
 *
 * 一家賣書的店大部分是幾百元的訂單，要不要開分期是商業決定，所以做成環境變數
 * 而不是常數。要限定成「只收一次付清」就設 BLACKCAT_LIMIT_PRODUCT_ID=payuni.normal。
 */
function limitProductId(): string {
  return (process.env.BLACKCAT_LIMIT_PRODUCT_ID ?? "").trim();
}

/**
 * 金額上限（規格 P40：「金額上限以合約規範為主(預設為 100,000)」）。
 * 超過就在送出之前擋下來，不要讓客人到了刷卡頁才看到對方的錯誤訊息。
 */
export const MAX_ORDER_AMOUNT = 100_000;

/** 對外 API 的逾時。建單是同步等的（客人在等付款網址），不能無限期掛著。 */
const REQUEST_TIMEOUT_MS = 20_000;

// ─────────────────────────────── 路徑與網址 ───────────────────────────────

/** APN 主動通知路徑。src/server.ts 用同一個常數攔截，避免兩邊寫死不同字串。 */
export const BLACKCAT_APN_PATH = "/api/webhooks/blackcat";

/** 瀏覽器導回路徑。同上。 */
export const BLACKCAT_RETURN_PATH = "/api/payments/blackcat/return";

/**
 * APN 網址，附上伺服器產生的密鑰（?k=）當第一道閘門 —— 與 PayUni 的
 * payuniNotifyUrl() 同一個形狀，理由也一樣：這是一個公開網址，而 APN 的
 * checksum 擋不住偽造（見檔頭坑 1）。缺密鑰就回 null，由 blackcatConfigured()
 * 擋掉整條刷卡路線。
 *
 * ⚠️ 規格 P40 的 apn_url 上限 250 字元，`?k=` 之後的密鑰也算在內。
 *
 * ── 🔴 2026-09-02：這裡原本不擋 localhost，結果掉了一張單 ────────────────
 * 原本的註解寫著：「SITE_URL 設成 localhost 時對方當然打不進來，那要靠部署設定，
 * 不是這裡。」那句話預測對了失敗，卻把責任交給一個沒有人在檢查的地方 ——
 * **`SITE_URL` 從來沒有設在 Vercel 上**，`siteUrl()` 因此退回預設值
 * `http://localhost:8080`，而這一支與 blackcatReturnUrl() 共用它。
 *
 * 後果：客人刷卡成功被導到 localhost（看到「無法連線」），而我們送給黑貓的 APN
 * 網址也是 localhost —— 通知永遠不會到，訂單卡在 pending，兩小時後被
 * expire_unpaid_orders() 取消、座位還回去，而錢已經收了。
 * （實際發生在 IB-202600001191，NT$1,800，靠人工回查黑貓才救回來。）
 *
 * 所以現在擋在這裡。判準不是「哪個環境」而是「金流商連得到嗎」——
 * loopback 位址與非 https 的網址，**在任何環境下**都不是一個有效的 APN 目的地。
 * 本機開發不受影響：那時候沒有真的憑證，blackcatConfigured() 本來就是 false。
 *
 * 擋下來的後果是整條刷卡路線降級成「不經金流」（訂單成立、由店家另行安排付款），
 * 那是**吵的**失敗 —— 比「刷得過但通知送不到」那種安靜的失敗好得多。
 */
const UNREACHABLE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function blackcatApnUrl(): string | null {
  const secret = process.env.BLACKCAT_WEBHOOK_SECRET;
  if (!secret) return null;
  let url: URL;
  try {
    url = new URL(`${siteUrl()}${BLACKCAT_APN_PATH}`);
  } catch {
    return null;
  }
  // 🔴 金流商的伺服器從外網打進來。這兩條擋掉它永遠到不了的目的地。
  if (url.protocol !== "https:") return null;
  if (UNREACHABLE_HOSTS.has(url.hostname) || url.hostname.endsWith(".local")) return null;
  url.searchParams.set("k", secret);
  const out = url.toString();
  return out.length <= 250 ? out : null;
}

/**
 * 授權成功導回網址（建單時的 success_url，規格 P40）。
 *
 * ⚠️ token 必須在**建單當下**就組進網址：對方導回時只會帶它自己的參數，
 * 不會幫我們把 public_token 傳回來。這與 payuniReturnUrl() 是同一個道理。
 *
 * ⚠️ 規格**沒有**「授權失敗指定網址」這個建單欄位 —— 失敗轉址只能在黑貓 PAY
 *    後台設定（P48）。所以後台那一格要填**不帶 token** 的同一條路徑，
 *    handler 會用 cust_order_no 找回訂單。
 */
export function blackcatReturnUrl(publicToken: string): string {
  return `${siteUrl()}${BLACKCAT_RETURN_PATH}?t=${encodeURIComponent(publicToken)}`;
}

/**
 * 這條刷卡路線能不能用。
 *
 * ⚠️ 最後一條 `blackcatApnUrl() !== null` 是整個檔案最容易被誤刪的一行，它同時
 *    擋掉兩種災難：
 *      * BLACKCAT_WEBHOOK_SECRET 沒設 → APN 網址沒有閘門，任何人都能打
 *      * apn_url 超過 250 字 → 對方靜默截斷，通知永遠送不到
 *    而通知送不到的後果是「錢收了、訂單卡在 pending、庫存被 0006 的排程收回去」。
 *
 * ⚠️ hash_base 也列為必要條件，雖然少了它**刷卡本身還是會成功**（APN 才是權威）。
 *    理由是三組憑證是一起發的，缺一個代表這個部署根本沒設完；讓它降級成
 *    「不顯示刷卡選項」，比讓它變成「刷得過但導回頁驗不了簽、什麼都不敢顯示」
 *    要好解釋得多。
 */
export function blackcatConfigured(): boolean {
  return Boolean(
    blackcatCustId() &&
    apiPassword() &&
    hashBase() &&
    process.env.BLACKCAT_WEBHOOK_SECRET &&
    blackcatApnUrl() !== null,
  );
}

// ─────────────────────────────── 雜湊工具 ───────────────────────────────

function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

/**
 * 常數時間比對兩個十六進位摘要。
 *
 * 長度不同直接 false（timingSafeEqual 長度不同會 throw）。兩邊都轉小寫再比：
 * 規格的範例算出來是小寫，但文件沒有明寫大小寫，收到大寫不該被判成偽造。
 */
function digestMatches(expected: string, given: unknown): boolean {
  const g = String(given ?? "")
    .trim()
    .toLowerCase();
  const e = expected.toLowerCase();
  if (g.length !== e.length || g.length === 0) return false;
  return timingSafeEqual(Buffer.from(g, "utf8"), Buffer.from(e, "utf8"));
}

/**
 * APN 數字欄位 → 整數。
 *
 * 規格的範例裡同一個概念有時是 number（COCS 的 "pay_amount":888）有時是字串
 * （CVS 的 "pay_amount":"1250"），所以兩種都要吃。回 null 代表「這個欄位沒有值
 * 或不是數字」—— 那與 0 是**完全不同**的意思，呼叫端必須分開處理。
 */
export function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const trimmed = v.trim().replace(/["']/g, "");
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

// ────────────────────── 驗簽（一）：APN 的 checksum ──────────────────────

/**
 * 依規格 P89 重算 APN 的 checksum：
 *
 *     MD5( api_id + ":" + trans_id + ":" + amount + ":" + status + ":" + nonce )
 *
 * **冒號分隔、不含 hash_base、只有這 5 個欄位。**
 *
 * ⚠️ `amount` 必須用**收到的原樣**去算，不要先 toInt() 再轉回字串。對方拿去算的
 *    就是它送出來的那個字面值；1250 與 "1250" 算出來一樣，但 "1250.0" 或
 *    " 1250" 不一樣，而我們無權替它正規化。
 */
export function apnChecksum(input: {
  apiId: unknown;
  transId: unknown;
  amount: unknown;
  status: unknown;
  nonce: unknown;
}): string {
  const part = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return md5Hex(
    [input.apiId, input.transId, input.amount, input.status, input.nonce].map(part).join(":"),
  );
}

/**
 * 這則 APN 的 checksum 對不對。
 *
 * 🔴 **這不是身分驗證。** 它只證明「這則通知的五個欄位彼此一致」，因為算式裡
 *    沒有任何祕密（見檔頭坑 1）。任何人都能產生一則 checksum 正確的假通知。
 *    通過這個函式**不代表**可以標記付款 —— 標記付款的唯一依據是
 *    queryCocsOrder() 回查到的 process_code。
 *
 *    函式名字刻意不叫 verifyApnSignature，因為那會讓人以為它做了它沒做的事。
 */
export function apnChecksumMatches(input: {
  apiId: unknown;
  transId: unknown;
  amount: unknown;
  status: unknown;
  nonce: unknown;
  checksum: unknown;
}): boolean {
  const given = String(input.checksum ?? "").trim();
  // 規格 P89 明寫長度 32。長度不對就是格式錯，連算都不用算。
  if (given.length !== 32) return false;
  return digestMatches(apnChecksum(input), given);
}

/**
 * APN 實際授權金額 —— `payment_detail.pay_amount`（規格 P88）。
 *
 * 🔴 **刻意不 fallback 到 order_amount / amount。**
 *    快樂手那一版寫的是 `payAmount ?? remoteAmount`，其中 remoteAmount 是回查
 *    拿到的 order_amount。但 order_amount 是「我們當初送出去的訂單金額」，
 *    它**永遠**等於 orders.total —— 所以那個 fallback 一旦生效，金額比對就變成
 *    `orders.total === orders.total`，恆真，整個檢查等於沒有。
 *
 *    正確的行為是：授權成功卻讀不到 pay_amount ⇒ **拒絕標記付款、留給人工對帳**，
 *    與 payuni-webhook 的 missing_amount 同一條路。少收一次錢可以補，
 *    把沒收到的錢當成收到了不能補。
 *
 * ⚠️ COCS 把它放在 payment_detail 裡（P88），CVS 代收代付卻是**頂層欄位**（P37）。
 *    兩邊都讀，是為了將來接第二條路時不用回來改 —— 但 COCS 只會走前者。
 */
export function apnPaidAmount(body: Record<string, unknown>): number | null {
  const detail = (body.payment_detail ?? {}) as Record<string, unknown>;
  const nested = toInt(detail.pay_amount);
  if (nested !== null) return nested;
  return toInt(body.pay_amount);
}

/** APN 的訂單狀態碼（規格 P87-88）。只有 AUTHORIZED 會觸發出貨流程。 */
export const APN_STATUS = {
  /** B=授權完成 */
  AUTHORIZED: "B",
  /** O=請款作業中（此時無法取消授權） */
  CAPTURING: "O",
  /** E=請款完成 */
  CAPTURED: "E",
  /** F=授權失敗 */
  AUTH_FAILED: "F",
  /** D=訂單逾期 */
  EXPIRED: "D",
  /** P=請款失敗 */
  CAPTURE_FAILED: "P",
  /** M=取消交易完成 */
  REFUNDED: "M",
  /** N=取消交易失敗 */
  REFUND_FAILED: "N",
  /** Q=取消授權完成 */
  AUTH_CANCELLED: "Q",
  /** R=取消授權失敗 */
  AUTH_CANCEL_FAILED: "R",
  /** I=開立發票通知 */
  INVOICE_ISSUED: "I",
  /** J=開立發票折讓單號通知 */
  INVOICE_ALLOWANCE: "J",
} as const;

/**
 * 「錢確實沒了」的 APN 狀態碼 —— 授權失敗、逾期、取消授權完成。
 *
 * ⚠️ 刻意**不含** P（請款失敗）與 N（取消交易失敗）：那兩個狀態下授權其實還在，
 *    把訂單標成 failed 會讓客人以為沒付到錢而重刷一次。它們只記錄、不改狀態。
 */
export const APN_TERMINAL_FAILURES = new Set<string>([
  APN_STATUS.AUTH_FAILED,
  APN_STATUS.EXPIRED,
  APN_STATUS.AUTH_CANCELLED,
]);

// ────────────────────── 驗簽（二）：導回的 chk ──────────────────────

/**
 * 授權**成功**導回的 chk（規格 P46）：
 *
 *     MD5( hash_base +'$'+ order_amount +'$'+ send_time +'$'+ ret +'$'+
 *          acquire_time +'$'+ auth_code +'$'+ card_no +'$'+ notify_time +'$'+
 *          cust_order_no )
 *
 * ⚠️ **順序不是欄位表的順序**：send_time 排在 ret 前面，cust_order_no 在最後。
 *    照欄位表由上而下串會得到一個不一樣的、永遠對不上的摘要。
 */
export function returnChkSuccess(q: {
  orderAmount: unknown;
  sendTime: unknown;
  ret: unknown;
  acquireTime: unknown;
  authCode: unknown;
  cardNo: unknown;
  notifyTime: unknown;
  custOrderNo: unknown;
}): string {
  const part = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return md5Hex(
    [
      hashBase(),
      part(q.orderAmount),
      part(q.sendTime),
      part(q.ret),
      part(q.acquireTime),
      part(q.authCode),
      part(q.cardNo),
      part(q.notifyTime),
      part(q.custOrderNo),
    ].join("$"),
  );
}

/**
 * 授權**失敗**導回的 chk（規格 P48）：
 *
 *     MD5( hash_base +'$'+ order_amount +'$'+ send_time +'$'+ ret +'$'+
 *          notify_time +'$'+ cust_order_no )
 *
 * 少了 acquire_time / auth_code / card_no —— 授權沒成功，那三個欄位不存在。
 * 拿成功那條公式來驗失敗導回，會永遠驗不過。
 *
 * ⚠️ 規格 P48 明寫失敗轉址「僅玉山銀、中信銀可用，統一金流授權失敗後不會轉址，
 *    會停留在失敗結果頁」。我們的收單行就是統一金流，所以實務上大概收不到這條。
 *    留著是為了完整性，以及日後換收單行不用回頭補。
 */
export function returnChkFail(q: {
  orderAmount: unknown;
  sendTime: unknown;
  ret: unknown;
  notifyTime: unknown;
  custOrderNo: unknown;
}): string {
  const part = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return md5Hex(
    [
      hashBase(),
      part(q.orderAmount),
      part(q.sendTime),
      part(q.ret),
      part(q.notifyTime),
      part(q.custOrderNo),
    ].join("$"),
  );
}

/**
 * 驗證一份導回的 query string。ret==="OK" 走成功公式，其餘走失敗公式。
 *
 * 缺 hash_base 一律回 false（不是「跳過檢查」）—— 驗不了就是驗不過。
 */
export function verifyReturnChk(params: URLSearchParams): boolean {
  if (!hashBase()) return false;
  const get = (k: string) => params.get(k) ?? "";
  const chk = get("chk");
  if (chk.length !== 32) return false;

  const ret = get("ret");
  const expected =
    ret === "OK"
      ? returnChkSuccess({
          orderAmount: get("order_amount"),
          sendTime: get("send_time"),
          ret,
          acquireTime: get("acquire_time"),
          authCode: get("auth_code"),
          cardNo: get("card_no"),
          notifyTime: get("notify_time"),
          custOrderNo: get("cust_order_no"),
        })
      : returnChkFail({
          orderAmount: get("order_amount"),
          sendTime: get("send_time"),
          ret,
          notifyTime: get("notify_time"),
          custOrderNo: get("cust_order_no"),
        });

  return digestMatches(expected, chk);
}

// ─────────────────────────────── 時間格式 ───────────────────────────────

/**
 * `yyyy-MM-dd HH:mm:ss`，**台北時間**。規格所有 send_time 都是這個格式，而且
 * 明寫「必須為傳送時之最新時間」。
 *
 * ⚠️ 不要用 toISOString() —— 那是 UTC，會差 8 小時，而對方回的錯誤訊息是
 *    「send_time 異常」（規格 P68 異常 6），看不出來是時區問題。
 *
 * ⚠️ 規格的欄位表把 send_time 的長度寫成 10，但它的範例是
 *    「2017-07-18 07:17:25」共 19 碼。那是規格的筆誤，以範例為準。
 */
export function taipeiTimestamp(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // en-CA 的 hour12:false 在部分 runtime 會把午夜給成 "24"，規格要的是 "00"。
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  return `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}:${pick("second")}`;
}

// ─────────────────────────────── Token ───────────────────────────────

interface CachedToken {
  token: string;
  /** epoch ms，已經扣掉安全邊際。 */
  expiresAt: number;
}
let cachedToken: CachedToken | null = null;

/** 測試用：清掉 token 快取。 */
export function resetTokenCache(): void {
  cachedToken = null;
}

/**
 * 取得 Bearer token（規格 P10）。
 *
 * POST {BaseUrl}/Token，`application/x-www-form-urlencoded`，
 * grant_type=password & username=<契客代號> & password=<API 密碼>。
 *
 * ⚠️ 有效期規格自己講了三種（內文 3 小時、欄位表「預設 1 天」、範例 86399 秒），
 *    但它同時指定了權威來源：「以 .expires 欄位表示的到期時間為主」。所以這裡讀
 *    `.expires`，而且那個 key **字面上就有一個開頭的點**（`json[".expires"]`），
 *    值是 GMT 字串而且範例裡前面有一個空格，要 trim。
 *
 * ⚠️ 提前 5 分鐘失效，避免在邊界上拿到一個馬上就過期的 token。
 *    讀不到 .expires 時退回 30 分鐘 —— 短一點只是多取幾次，長一點會是 401。
 */
async function getToken(): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return { ok: true, token: cachedToken.token };

  const body = new URLSearchParams({
    grant_type: "password",
    username: blackcatCustId(),
    password: apiPassword(),
  });

  let res: Response;
  try {
    res = await fetch(`${blackcatBaseUrl()}/Token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `連線失敗：${err instanceof Error ? err.message : "unknown"}` };
  }

  const raw = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // ⚠️ 刻意不把 raw 印出來 —— 失敗回應可能夾帶帳號。只留狀態碼。
    return { ok: false, reason: `取得 token 失敗：回應不是 JSON（HTTP ${res.status}）` };
  }

  const token = typeof json.access_token === "string" ? json.access_token : "";
  if (!token) {
    // 規格 P10 的錯誤欄位表寫大寫 Error，範例卻是小寫 error —— 兩個都收。
    const code = json.error ?? json.Error ?? `HTTP ${res.status}`;
    const desc = json.error_description ?? "";
    return { ok: false, reason: `取得 token 失敗：${String(code)} ${String(desc)}`.trim() };
  }

  let expiresAt = now + 30 * 60_000;
  const expiresRaw = json[".expires"];
  if (typeof expiresRaw === "string") {
    const parsed = Date.parse(expiresRaw.trim());
    if (Number.isFinite(parsed)) expiresAt = parsed;
  }
  cachedToken = { token, expiresAt: expiresAt - 5 * 60_000 };
  return { ok: true, token };
}

/**
 * 打一次 /api/Collect。COCS 的所有指令共用這一個端點，靠 `cmd` 區分。
 *
 * ⚠️ 規格 P9 特別註明「Bearer 與 Token 之間要有空格」。
 * ⚠️ 這支 API **不需要任何 checksum**，只靠 Bearer token。建單、查詢、取消授權、
 *    請款、退款全部一樣 —— 檔頭那兩套 MD5 只用在**對方送過來**的東西上。
 */
async function collect(
  payload: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  const auth = await getToken();
  if (!auth.ok) return auth;

  let res: Response;
  try {
    res = await fetch(`${blackcatBaseUrl()}/api/Collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `連線失敗：${err instanceof Error ? err.message : "unknown"}` };
  }

  const raw = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: `回應不是 JSON（HTTP ${res.status}）` };
  }

  // 規格：status 只有 OK 與 ERROR 兩種。失敗時 msg 帶異常訊息。
  if (json.status !== "OK") {
    return { ok: false, reason: String(json.msg ?? `HTTP ${res.status}`) };
  }
  return { ok: true, data: json };
}

// ─────────────────────── 建單（CocsOrderAppend, P40）───────────────────────

export interface BlackcatOrderInput {
  /** 直接沿用 orders.order_no（IB-202600000001，15 碼）。規格上限 30 碼。 */
  orderNo: string;
  /** 整數新台幣。 */
  amount: number;
  /** 訂單/商品明細。規格 P40 紅字「為符合政府法規必須填寫」，上限 500 字。 */
  detail: string;
  /** APN 網址；由 blackcatApnUrl() 產生（含 ?k= 閘門）。 */
  apnUrl: string;
  /** 授權成功導回；由 blackcatReturnUrl(publicToken) 產生。 */
  successUrl: string;
}

export type BlackcatOrderResult =
  | { ok: true; url: string; custOrderNo: string }
  | { ok: false; reason: string };

/** 契客訂單號碼：規格上限 30 碼；統一金流收單時 25 碼（P14）。保守取 25。 */
const CUST_ORDER_NO_RE = /^[A-Za-z0-9_-]{1,25}$/;

/**
 * 建立一筆線上刷卡訂單，拿回付款網址。
 *
 * ⚠️ 與 PayUni 最大的差別：**這一步在伺服器端就把交易建出來了**，回來的是一個
 *    可以直接 `location.assign()` 過去的網址。PayUni 是「瀏覽器 POST 表單才產生
 *    交易」，所以 payuni.ts 回的是 form。兩者的 PaymentHandoff 形狀不同，
 *    見 src/lib/checkout.ts。
 */
export async function createCocsOrder(input: BlackcatOrderInput): Promise<BlackcatOrderResult> {
  if (!blackcatConfigured()) return { ok: false, reason: "黑貓 PAY 未設定完成" };
  if (!CUST_ORDER_NO_RE.test(input.orderNo)) {
    return { ok: false, reason: `cust_order_no 格式不符：${input.orderNo}` };
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, reason: `金額不合法：${input.amount}` };
  }
  if (input.amount > MAX_ORDER_AMOUNT) {
    return { ok: false, reason: `金額超過上限 ${MAX_ORDER_AMOUNT}` };
  }

  const payload: Record<string, unknown> = {
    cmd: "CocsOrderAppend",
    cust_id: blackcatCustId(),
    cust_order_no: input.orderNo,
    order_amount: input.amount,
    // 規格 P43 異常 9：order_detail 不可包含 HTML tag。拿掉角括號並截到 500。
    order_detail: input.detail.replace(/[<>]/g, "").slice(0, 500),
    acquirer_type: blackcatAcquirerType(),
    send_time: taipeiTimestamp(),
    apn_url: input.apnUrl,
    success_url: input.successUrl,
  };
  const limit = limitProductId();
  if (limit) payload.limit_product_id = limit;

  const res = await collect(payload);
  if (!res.ok) return res;

  const url = typeof res.data.url === "string" ? res.data.url : "";
  if (!url) return { ok: false, reason: "回應成功但沒有刷卡網址" };
  return { ok: true, url, custOrderNo: String(res.data.cust_order_no ?? input.orderNo) };
}

// ─────────────────────── 訂單查詢（CocsOrderQuery, P55）───────────────────────

/**
 * 訂單程序狀態代碼中，代表「銀行確實授權過」的那些（規格附件 1，P94-95）。
 *
 *   15 授權完成 ── 這是最早可以確定錢拿得到的點
 *   20 請求請款 / 21 請款作業中 / 22 請款完成 ── 已經走得更遠了
 *
 * ⚠️ 不含 13（刷卡確認頁）與 14（繳款人確認）—— 那兩個只代表客人走到了頁面上，
 *    銀行還沒授權。把它們當成付款成功就是「還沒刷就出貨」。
 * ⚠️ 也不含 23（請款失敗）：授權還在、錢還在，但清算失敗，需要人看。
 */
export const AUTHORIZED_PROCESS_CODES = new Set<number>([15, 20, 21, 22]);

/** 明確代表這筆錢拿不到了的 process_code（16 授權失敗 / 6 逾期 / 5 註銷 / 17 取消授權完成 / 27 退貨完成）。 */
export const FAILED_PROCESS_CODES = new Set<number>([5, 6, 16, 17, 27]);

export interface BlackcatQueryResult {
  /** 訂單程序狀態代碼（規格附件 1）。讀不到時為 null。 */
  processCode: number | null;
  /** 代繳金額 —— 這是「我們當初送出去的訂單金額」，**不是實收金額**。 */
  orderAmount: number | null;
  /** 授權銀行中文名（玉山銀行/中國信託/統一金流）。 */
  acquirerType: string | null;
  /** 完整回應，寫進 webhook_events 供對帳。 */
  raw: Record<string, unknown>;
}

/**
 * 回查一筆訂單在**黑貓伺服器上**的真實狀態。
 *
 * 🔴 這是整個串接的安全基石，不是效能上的可選項。APN 的 checksum 裡沒有祕密
 *    （檔頭坑 1），所以通知內容一律不可信；能拿來標記付款的只有這裡回來的
 *    process_code。src/server/blackcat-webhook.ts 每一次都會呼叫它，回查失敗就
 *    fail-closed 逼對方重送。
 */
export async function queryCocsOrder(
  orderNo: string,
): Promise<{ ok: true; result: BlackcatQueryResult } | { ok: false; reason: string }> {
  if (!blackcatConfigured()) return { ok: false, reason: "黑貓 PAY 未設定完成" };

  const res = await collect({
    cmd: "CocsOrderQuery",
    cust_id: blackcatCustId(),
    cust_order_no: orderNo,
  });
  if (!res.ok) return res;

  return {
    ok: true,
    result: {
      processCode: toInt(res.data.process_code),
      orderAmount: toInt(res.data.order_amount),
      acquirerType:
        typeof res.data.acquirer_type === "string" ? res.data.acquirer_type.trim() : null,
      raw: res.data,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 第二條路（代收代付：ibon / ATM 虛擬帳號 / 三段條碼）—— **這一輪刻意沒接**
// ───────────────────────────────────────────────────────────────────────────
//
// 憑證是同一組（同一個契客代號、同一個 API 密碼、同一個 hash_base、同一個
// Bearer token），端點也是同一個 /api/Collect，所以要加的時候不用碰上面任何
// 一行。差異全部集中在四個地方：
//
//   1. cmd 換成 CvsOrderAppend（規格 P14-18）。必填欄位比 COCS 多很多：
//      expire_date（繳費到期日 YYYY-MM-DD，必填）、payer_name / payer_postcode /
//      payer_address / payer_mobile / payer_email（收單行為統一金流時必填），
//      payment_type（0=ibon 繳款、1=ATM 銀行轉帳）、
//      payment_acquirerType（2=安源、3=統一金流）。
//      回覆帶的是繳款代碼／虛擬帳號／三段條碼，**不是**一個付款網址 ——
//      所以 PaymentHandoff 還要再多一種 kind（"instructions"），
//      而不是硬塞進現在的 redirect。
//
//   2. 查詢換成 CvsOrderQuery（P19-22）。
//
//   3. APN 的形狀不同（P35-39）：
//      🔴 `pay_amount` 是**頂層欄位**，不在 payment_detail 裡（COCS 相反）。
//         apnPaidAmount() 已經兩邊都讀了，所以那一層不用改。
//      🔴 checksum 公式完全相同（api_id:trans_id:amount:status:nonce），
//         所以「不可信、必須回查」這條規則一字不變地適用。
//      狀態碼是另一組（3=等待繳款、4=已繳納、6=逾期…，見附件 1）。
//
//   4. orders.payment_method 的 CHECK 目前是 ('card','atm','cvs_cod','test_paid')。
//      ibon 對得上 'cvs_cod'、ATM 虛擬帳號對得上 'atm'，兩個都已經在裡面，
//      所以**多半不需要動那條 CHECK**。真的要加新值（例如 'blackcat_ibon'）時，
//      規矩是新開一支 migration 用 drop constraint + add constraint，
//      既有 0001–0024 一行不動 —— 0024 的檔頭寫了確切的 SQL。
//
// 先把線上刷卡這一條走完、驗透，再加第二條。
