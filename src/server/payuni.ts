/**
 * PayUni 統一金流 —— 加解密、驗簽、整合式支付頁（UPP）表單。
 *
 * ── 這個檔案為什麼不 import 任何專案模組 ────────────────────────────────────
 * 只依賴 node:crypto。scripts/payuni-selftest.mjs 才能不經過 bundler、不經過
 * tsconfig paths，直接 import 這一份「產線上真正跑的程式碼」用測試向量驗證。
 * 驗一份複製品等於沒驗。所以這裡沒有 `import "@tanstack/react-start/server-only"`，
 * 保護改由檔案位置提供：vite 設定把 `**\/server\/**` 列入 client importProtection
 * （behavior: "error"，見 node_modules/@lovable.dev/vite-tanstack-config），
 * 任何 client 端模組 import 到這裡都會直接讓 build 失敗。
 *
 * ── 加解密規格（對照 goodday/web/src/lib/payments/payuni.ts 的已驗證實作）──
 *   * 演算法 aes-256-gcm
 *   * key = HashKey 原字串（僅 trim，不做任何 hash），固定 32 bytes
 *   * iv  = HashIV  原字串（僅 trim，不做任何 hash），固定 16 bytes
 *     ⚠️ iv 是 16 bytes，不是 GCM 慣例的 12 bytes —— PayUni 就是 16。
 *   * 明文 = 參數的 application/x-www-form-urlencoded query string（中文 UTF-8 percent-encode）
 *   * EncryptInfo = hex( base64(密文) + ":::" + base64(GCM authTag) )   ← 三個冒號
 *   * HashInfo    = SHA256(HashKey + EncryptInfo + HashIV) 的 hex，轉大寫
 *
 * ── 沒有商店憑證，所以下面這些「只能等憑證才驗得到」──────────────────────
 *   1. UPP 支付頁是否接受我們組出的欄位（需要真實 MerID 才會回應）。
 *   2. NotifyURL 的 ack 格式：官方文件查不到「要回什麼給 PayUni 才算收到」。
 *      目前回 HTTP 200 純文字 "OK"（見 src/server/payuni-webhook.ts）。
 *   3. /api/trade/query 的外層 Version 值：文件只明確寫 UPP 是 "2.0"，查詢 API
 *      的版本號未載明，此處用 "1.0"（見 TRADE_QUERY_VERSION）。因為沒驗過，
 *      webhook 預設**不**依賴反查（見 PAYUNI_VERIFY_BY_QUERY）。
 */
import { createCipheriv, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

/** UPP 整合式支付頁的固定版本號（官方文件明載）。 */
export const UPP_VERSION = "2.0";

/**
 * 交易查詢 API 的版本號。
 * TODO（沙盒實測）：官方文件只明確寫 UPP 是 "2.0"，查詢 API 的 Version 未載明。
 * 若沙盒查詢回 Status 非 SUCCESS 且 Message 提到版本，請優先調整這個常數。
 */
export const TRADE_QUERY_VERSION = "1.0";

/** 付款成功的權威判定值。其他值：0=取號成功 2=付款失敗 3=付款取消 8=訂單待確認 */
export const TRADE_STATUS_PAID = "1";
export const TRADE_STATUS_FAILED = "2";
export const TRADE_STATUS_CANCELLED = "3";

/**
 * 站台網址。webhook 與導回頁都需要絕對網址，而 PayUni 是從外網打進來的，
 * 沒辦法用相對路徑。未設定時退回本機 dev port（vite 設定固定 8080）。
 */
export function siteUrl(): string {
  return (process.env.SITE_URL ?? "http://localhost:8080").replace(/\/+$/, "");
}

/**
 * 環境判斷刻意「fail-safe 到沙盒」：只有 PAYUNI_SANDBOX 明確等於字串 "false"
 * 才會打正式環境，未設定／空字串／任何其他值一律走沙盒。
 *
 * 兩種設錯的後果不對等：
 *   * 該正式卻走沙盒 → 客人刷不到真的錢，訂單卡 pending，可回頭補救。
 *   * 該沙盒卻走正式 → 測試時真的從客人的卡扣款，只能退刷。
 * 所以預設值選比較安全的那一邊。
 */
export function isSandbox(): boolean {
  return process.env.PAYUNI_SANDBOX !== "false";
}

function apiBase(): string {
  return isSandbox() ? "https://sandbox-api.payuni.com.tw" : "https://api.payuni.com.tw";
}

/** 商店代號。未設定時回空字串，由 payuniConfigured() 先擋掉。 */
export function payuniMerId(): string {
  return (process.env.PAYUNI_MER_ID ?? "").trim();
}

/**
 * PayUni 是否可用 —— 「可用」的定義是「付款結果一定回得來」，不只是「金鑰有填」。
 *
 * ⚠️ 最後一條 payuniNotifyUrl() !== null 是整個檔案最容易被誤刪的一行，它同時
 * 擋住兩種設定失誤：
 *   * 缺 PAYUNI_WEBHOOK_SECRET
 *   * SITE_URL 沒設 / 設成 localhost / 設了非 80,443 的 port
 * 兩者的後果一樣：建立交易時不會帶 NotifyURL，客人真的被扣款成功，我們卻永遠
 * 收不到通知 —— 訂單卡在 pending，30 分鐘後還會被 0006 的逾時回收當成未付款
 * 取消掉，變成「錢收了、庫存也還回去了」。而且 SITE_URL 錯掉時連 ReturnURL 都
 * 是死的，客人付完款會落在一個開不起來的網址上。
 *
 * 這種設定錯誤在測試環境不會被發現（本機本來就收不到通知），所以只能靠這裡
 * fail-safe：寧可整個不開放刷卡、退回「由我們聯繫付款」，也不要開放一個
 * 會吃掉客人的錢又取消訂單的刷卡。
 */
export function payuniConfigured(): boolean {
  return Boolean(
    payuniMerId() &&
    process.env.PAYUNI_HASH_KEY &&
    process.env.PAYUNI_HASH_IV &&
    process.env.PAYUNI_WEBHOOK_SECRET &&
    payuniNotifyUrl() !== null,
  );
}

// ────────────────────────────── 加解密核心 ──────────────────────────────

export type PayuniParams = Record<string, string | number | undefined | null>;

/**
 * 金鑰解析。keyOverride/ivOverride 存在的唯一目的是讓 selftest 用測試向量驗證
 * 同一份程式碼；產線呼叫一律不傳，走環境變數。
 * 長度檢查放在呼叫時（而非 module load 時），確保沒設金鑰也能正常 import / build。
 */
function resolveKeys(keyOverride?: string, ivOverride?: string) {
  const hashKey = (keyOverride ?? process.env.PAYUNI_HASH_KEY ?? "").trim();
  const hashIv = (ivOverride ?? process.env.PAYUNI_HASH_IV ?? "").trim();
  const keyBuf = Buffer.from(hashKey, "utf8");
  const ivBuf = Buffer.from(hashIv, "utf8");
  if (keyBuf.length !== 32) {
    throw new Error(`PayUni HashKey 長度須為 32 bytes（目前 ${keyBuf.length}）`);
  }
  if (ivBuf.length !== 16) {
    throw new Error(`PayUni HashIV 長度須為 16 bytes（目前 ${ivBuf.length}）`);
  }
  return { hashKey, hashIv, keyBuf, ivBuf };
}

/** 參數 → application/x-www-form-urlencoded 明文。undefined/null 直接略過不送。 */
export function toPlaintext(params: PayuniParams): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.append(k, String(v));
  }
  return sp.toString();
}

/** 產生 EncryptInfo（hex 字串）。 */
export function encryptInfo(
  params: PayuniParams,
  keyOverride?: string,
  ivOverride?: string,
): string {
  const { keyBuf, ivBuf } = resolveKeys(keyOverride, ivOverride);
  const cipher = createCipheriv("aes-256-gcm", keyBuf, ivBuf);
  let cipherText = cipher.update(toPlaintext(params), "utf8", "base64");
  cipherText += cipher.final("base64");
  const tag = cipher.getAuthTag().toString("base64");
  return Buffer.from(`${cipherText}:::${tag}`).toString("hex").trim();
}

/** 產生 HashInfo：SHA256(HashKey + EncryptInfo + HashIV) 的大寫 hex。 */
export function hashInfo(
  encryptInfoHex: string,
  keyOverride?: string,
  ivOverride?: string,
): string {
  const { hashKey, hashIv } = resolveKeys(keyOverride, ivOverride);
  return createHash("sha256")
    .update(`${hashKey}${encryptInfoHex}${hashIv}`)
    .digest("hex")
    .toUpperCase();
}

/**
 * 驗簽：用自己的金鑰重算 HashInfo，與對方送來的值常數時間比對。
 * ⚠️ 呼叫順序上這一步必須在 decryptInfo() 之前 —— 驗簽不過的封包連解都不要解。
 */
export function verifyHashInfo(
  encryptInfoHex: string,
  receivedHashInfo: string | null | undefined,
  keyOverride?: string,
  ivOverride?: string,
): boolean {
  if (!receivedHashInfo) return false;
  let expected: string;
  try {
    expected = hashInfo(encryptInfoHex, keyOverride, ivOverride);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(receivedHashInfo.trim().toUpperCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 解密 EncryptInfo，回傳明文字串。
 * GCM authTag 會在 final() 時驗證，被竄改的密文會直接 throw（完整性保護）。
 */
export function decryptInfoRaw(
  encryptInfoHex: string,
  keyOverride?: string,
  ivOverride?: string,
): string {
  const { keyBuf, ivBuf } = resolveKeys(keyOverride, ivOverride);
  const hex = (encryptInfoHex ?? "").trim();
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("PayUni EncryptInfo 非合法 hex 字串");
  }
  const raw = Buffer.from(hex, "hex").toString("utf8");
  // base64 字母表不含 ":"，所以用 ":::" 切一定只會切出 2 段。
  const parts = raw.split(":::");
  if (parts.length !== 2) {
    throw new Error("PayUni EncryptInfo 格式錯誤（找不到 ::: 分隔）");
  }
  const [cipherB64, tagB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, ivBuf);
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  let plain = decipher.update(Buffer.from(cipherB64, "base64"), undefined, "utf8");
  plain += decipher.final("utf8");
  return plain;
}

/** 解密 EncryptInfo 並以 query string 格式 parse 成扁平物件（付款通知的格式）。 */
export function decryptInfo(
  encryptInfoHex: string,
  keyOverride?: string,
  ivOverride?: string,
): Record<string, string> {
  const plain = decryptInfoRaw(encryptInfoHex, keyOverride, ivOverride);
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(plain)) out[k] = v;
  return out;
}

// ────────────────────────────── 導回／通知網址 ──────────────────────────────

/**
 * 前景導回頁。
 *
 * ⚠️ gateway 導回時只會帶它自己的參數，不會幫我們把 public_token 傳回來，
 * 所以 token 必須在**建單當下**就組進 ReturnURL。這也是為什麼這個函式收的是
 * publicToken 而不是 orderNo —— /checkout/complete 只認 token（見該路由檔頭）。
 */
export function payuniReturnUrl(publicToken: string): string {
  return `${siteUrl()}/checkout/complete?token=${encodeURIComponent(publicToken)}`;
}

/** webhook 路徑。src/server.ts 用同一個常數攔截，避免兩邊寫死不同字串。 */
export const PAYUNI_WEBHOOK_PATH = "/api/webhooks/payuni";

/**
 * 背景通知網址，附上伺服器產生的密鑰（?k=）當第一道閘門。
 * PayUni 限制 NotifyURL 只能是 80/443 port —— 不符或缺密鑰時回 null（不送這個欄位）。
 */
export function payuniNotifyUrl(): string | null {
  const secret = process.env.PAYUNI_WEBHOOK_SECRET;
  if (!secret) return null;
  let url: URL;
  try {
    url = new URL(`${siteUrl()}${PAYUNI_WEBHOOK_PATH}`);
  } catch {
    return null;
  }
  const port = url.port;
  const okPort =
    port === "" ||
    (url.protocol === "https:" && port === "443") ||
    (url.protocol === "http:" && port === "80");
  if (!okPort) return null;
  url.searchParams.set("k", secret);
  return url.toString();
}

// ────────────────────────────── 建立交易（UPP）──────────────────────────────

/** MerTradeNo 規則：≤25 碼、只允許 [A-Za-z0-9_-]、10 分鐘內不可重複。 */
const MER_TRADE_NO_RE = /^[A-Za-z0-9_-]{1,25}$/;

export interface PayuniUppOrder {
  /** 直接沿用 orders.order_no（格式 IB-202600000001，15 碼，天生符合 PayUni 規則且全站唯一）。 */
  merTradeNo: string;
  /** 整數 TWD。 */
  amount: number;
  /** 商品說明，≤550 碼（超過會截斷）。 */
  prodDesc: string;
  /** 導回頁；由 payuniReturnUrl(publicToken) 產生。 */
  returnUrl: string;
}

export interface PayuniUppForm {
  /** 表單 POST 目的地（沙盒／正式不同網域）。 */
  action: string;
  /** 要以 hidden input 送出的四個外層欄位。 */
  fields: Record<string, string>;
}

/**
 * 組出要「由瀏覽器 Form POST」到 PayUni 整合式支付頁的內容。
 *
 * ⚠️ PayUni 沒有「伺服器端建立交易換一個 redirect URL」的流程 —— 交易是靠瀏覽器
 * 直接 POST 這四個欄位過去才成立，所以前端必須動態建 form 並 submit。
 * 不要為了「跟其他金流一致」把這裡改成回傳一個網址，那樣是行不通的。
 */
export function buildUppForm(order: PayuniUppOrder): PayuniUppForm {
  const merId = payuniMerId();
  if (!merId) throw new Error("缺少 PAYUNI_MER_ID");
  if (!MER_TRADE_NO_RE.test(order.merTradeNo)) {
    throw new Error(`PayUni MerTradeNo 格式不符（≤25 碼且只能 A-Za-z0-9_-）：${order.merTradeNo}`);
  }
  const amount = Math.round(Number(order.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`PayUni TradeAmt 需為正整數（收到 ${order.amount}）`);
  }

  const params: PayuniParams = {
    MerID: merId,
    MerTradeNo: order.merTradeNo,
    TradeAmt: amount,
    Timestamp: Math.floor(Date.now() / 1000),
    ProdDesc: (order.prodDesc || `小時光書店訂單 ${order.merTradeNo}`).slice(0, 550),
    ReturnURL: order.returnUrl,
    // 本次只開信用卡（Credit=1）。orders.payment_method 的 CHECK 另外收 atm /
    // cvs_cod，要開放時是在這裡加欄位，不是改 CHECK。
    Credit: 1,
  };

  // NotifyURL 只接受 80/443 port。本機開發（localhost:8080）PayUni 本來也連不進來，
  // 直接不送這個欄位，避免整筆交易被 PayUni 以「NotifyURL 格式錯誤」退掉。
  const notifyUrl = payuniNotifyUrl();
  if (notifyUrl) {
    params.NotifyURL = notifyUrl;
  } else {
    console.warn(
      "[payuni] NotifyURL 未帶入（非 80/443 port 或未設 PAYUNI_WEBHOOK_SECRET），付款結果將收不到背景通知",
    );
  }

  const encrypt = encryptInfo(params);
  return {
    action: `${apiBase()}/api/upp`,
    fields: {
      MerID: merId,
      Version: UPP_VERSION,
      EncryptInfo: encrypt,
      HashInfo: hashInfo(encrypt),
    },
  };
}

// ────────────────────────────── 主動查詢交易 ──────────────────────────────

export interface PayuniTradeQueryResult {
  /** 外層 Status，"SUCCESS" 代表這次「查詢請求」合法，不代表付款成功。 */
  status?: string;
  message?: string;
  /** "0"=取號成功 "1"=付款成功 "2"=付款失敗 "3"=付款取消 "8"=訂單待確認 */
  tradeStatus?: string;
  /** 金流實際收到的金額（整數 TWD）。 */
  tradeAmt?: number;
  paymentType?: string;
  /** "A"=完整資料 "B"=處理中，建議稍後重查 */
  dataSource?: string;
  merTradeNo?: string;
  tradeNo?: string;
  /** 解密後的原始欄位，除錯用。 */
  raw: Record<string, string>;
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return undefined;
}

/**
 * 解析查詢回應解密後的內容。
 * TODO（沙盒實測）：文件對這段的格式描述不一致 —— 付款通知是 query string，查詢 API
 * 則提到回應含 Result 陣列（那比較像 JSON）。這裡兩種都吃：先試 JSON、失敗退回
 * query string；JSON 若有 Result 陣列就取第一筆。
 */
export function parseQueryPayload(plain: string): Record<string, string> {
  const trimmed = plain.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const root = Array.isArray(parsed)
        ? (parsed[0] as Record<string, unknown> | undefined)
        : (parsed as Record<string, unknown>);
      if (root && typeof root === "object") {
        const result = (root as { Result?: unknown }).Result;
        const target = Array.isArray(result)
          ? ((result[0] as Record<string, unknown> | undefined) ?? {})
          : result && typeof result === "object"
            ? (result as Record<string, unknown>)
            : root;
        const flat: Record<string, string> = {};
        // 外層欄位（Status/Message）也一併保留，Result 內同名欄位優先。
        for (const [k, v] of Object.entries(root)) {
          if (k === "Result") continue;
          if (v !== null && typeof v !== "object") flat[k] = String(v);
        }
        for (const [k, v] of Object.entries(target)) {
          if (v !== null && typeof v !== "object") flat[k] = String(v);
        }
        return flat;
      }
    } catch {
      // 不是合法 JSON，往下用 query string 解
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(trimmed)) out[k] = v;
  return out;
}

/**
 * 伺服器對伺服器反查 —— 縱深防禦。
 *
 * ⚠️ 預設**沒有**接在 webhook 主線上（見 src/server/payuni-webhook.ts 的
 * PAYUNI_VERIFY_BY_QUERY）。理由：TRADE_QUERY_VERSION 是沒有憑證驗證過的猜測值，
 * 把它接成 fail-closed 的必經之路，猜錯就是「所有付款都推不進訂單狀態」。
 * 拿到沙盒憑證、實測查詢 API 通了之後，把 PAYUNI_VERIFY_BY_QUERY=true 打開。
 */
export async function queryPayuniTrade(merTradeNo: string): Promise<PayuniTradeQueryResult> {
  const merId = payuniMerId();
  if (!merId) throw new Error("缺少 PAYUNI_MER_ID");

  const encrypt = encryptInfo({
    MerID: merId,
    Timestamp: Math.floor(Date.now() / 1000),
    MerTradeNo: merTradeNo,
  });

  const body = new URLSearchParams({
    MerID: merId,
    Version: TRADE_QUERY_VERSION,
    EncryptInfo: encrypt,
    HashInfo: hashInfo(encrypt),
  });

  const res = await fetch(`${apiBase()}/api/trade/query`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`PayUni trade/query failed (HTTP ${res.status}): ${await res.text()}`);
  }

  const text = await res.text();
  let envelope: Record<string, string>;
  try {
    envelope = JSON.parse(text) as Record<string, string>;
  } catch {
    envelope = {};
    for (const [k, v] of new URLSearchParams(text)) envelope[k] = v;
  }

  const encInfo = envelope.EncryptInfo;
  if (!encInfo) {
    throw new Error(`PayUni trade/query 回應缺少 EncryptInfo：${text.slice(0, 300)}`);
  }
  // 回應也驗簽：確認這份密文確實由持有同一組 HashKey/HashIV 的一方產生。
  if (!verifyHashInfo(encInfo, envelope.HashInfo)) {
    throw new Error("PayUni trade/query 回應 HashInfo 驗簽失敗");
  }

  const payload = parseQueryPayload(decryptInfoRaw(encInfo));
  const amtRaw = pickFirst(payload, ["TradeAmt", "Amount"]);
  const amt = amtRaw === undefined ? undefined : Number(amtRaw);

  return {
    status: envelope.Status ?? pickFirst(payload, ["Status"]),
    message: envelope.Message ?? pickFirst(payload, ["Message"]),
    tradeStatus: pickFirst(payload, ["TradeStatus"]),
    tradeAmt: Number.isFinite(amt) ? (amt as number) : undefined,
    paymentType: pickFirst(payload, ["PaymentType"]),
    dataSource: pickFirst(payload, ["DataSource"]),
    merTradeNo: pickFirst(payload, ["MerTradeNo"]),
    tradeNo: pickFirst(payload, ["TradeNo"]),
    raw: payload,
  };
}
