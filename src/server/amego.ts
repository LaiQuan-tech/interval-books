/**
 * 光貿 Amego 電子發票 —— 簽章、金額計算、開立／作廢／查詢。
 *
 * ── 這個檔案為什麼幾乎不 import 任何專案模組 ──────────────────────────────
 * 與 src/server/payuni.ts 同一個理由：scripts/amego-selftest.mjs 要能不經過
 * bundler、不經過 tsconfig paths，直接 import「產線上真正跑的那一份」用測試向量
 * 驗證。驗一份複製品等於沒驗。真正不可以出現的是 `@/…` 這種要 tsconfig paths
 * 才解析得出來的別名；相對路徑 + 明確 `.ts` 副檔名的 import，Node 的原生型別
 * 剝離照樣讀得動 —— 所以與 src/server/blackcat.ts 同一個理由、同一種做法：
 * 下面從零相依的 `./public-url.ts` 借了 isPubliclyReachableHost()，用來驗
 * AMEGO_RELAY_URL（見檔尾「中繼」那一段），沒有第二個專案模組被拉進來。
 * 保護改由檔案位置提供：vite 設定把 `**\/server\/**` 列入 client importProtection
 * （behavior: "error"），任何 client 端模組 import 到這裡都會直接讓 build 失敗。
 *
 * ── 通訊協定（已用測試憑證實測，非文件推測）─────────────────────────────────
 * base `https://invoice-api.amego.tw`，**測試與正式同一個網址**，靠統編＋App Key 區分。
 * 每支 API 都是 POST + `application/x-www-form-urlencoded`（用 application/json 送
 * 會得到 `code:11 invoice(統編)不可為空`，因為伺服器根本沒解析到欄位），四個欄位：
 *
 *   invoice  統一編號
 *   data     業務參數的 JSON 字串（URLSearchParams 會自動做 url encode）
 *   time     Unix timestamp，與伺服器誤差須在 ±60 秒內
 *   sign     md5(data 的 JSON 字串 + time + AppKey)
 *
 * **有些端點吃物件、有些只吃陣列**，而且文件沒有整理成表：
 *   /json/f0401（開立）      物件      ← 傳陣列會被當成不合法
 *   /json/f0501（作廢）      **陣列**  ← 傳物件回 `code:3050112 …應為陣列字串`
 *   /json/invoice_query      物件
 *   /json/ban_query          **陣列**  ← 傳物件回 `code:23 …應為陣列字串`
 * 每一條都是實測出來的，不要「統一成同一種」。
 *
 * ── HTTP 200 不代表成功 ────────────────────────────────────────────────────
 * 這支 API **所有**回應都是 HTTP 200，成敗一律看 body 的 `code`（0 才是成功）。
 * 實測到的業務錯誤碼：
 *   15       time 時間戳記錯誤（時鐘漂移）
 *   16       sign 驗證錯誤
 *   71       查無資料（invoice_query 查不到 → 這張還沒開過）
 *   3040122  BuyerIdentifier 格式錯誤（統編檢核碼不對）
 *   3040123  BuyerName 不可為空或過長
 *   3040132  載具號碼不存在
 *   3040153  OrderId 不可為空或過長
 *   3040171  OrderId 重複  ← 冪等訊號，代表這張已經開過了
 *   3040178  TotalAmount 計算錯誤
 *   3050125  發票不存在（作廢時）
 *   3050131  等待作廢（已經送過作廢了）
 * 把 HTTP 200 當成功，就是把「統編格式錯誤」當成「發票開好了」。
 *
 * ── 時鐘（±60 秒）────────────────────────────────────────────────────────
 * Vercel 的機器時間通常是準的，但「通常」不是可以拿來開稅務憑證的保證，而且時鐘漂移的
 * 症狀是**全部**的發票都開不出來。作法：正常路徑直接用本機時間（不多打一次 API），
 * 收到 code 15 才呼叫 GET /json/time 校時、記住 offset、用校正後的時間重送一次。
 * offset 存在模組變數裡，同一個 instance 之後的呼叫都自動帶上，所以漂移只會讓
 * 「第一張」發票多花一次往返，不會讓任何一張開不出來。詳見 amegoRequest()。
 *
 * ── 中繼（可選）：AMEGO_RELAY_URL + AMEGO_RELAY_SECRET ─────────────────────
 * Amego 的發票 API 有來源 IP 白名單，而 Vercel 的出口 IP 是浮動的 —— 這是
 * 2026-09 四筆已收款訂單開不出發票（code=14 IP 未被允許，每筆重試 5 次都不同
 * IP）的成因。修法是一個部署在 Railway、有固定出口 IP 的中繼服務；光貿已把那些
 * IP 加進白名單，缺的是這一段接線。
 *
 * 兩個環境變數**都設好**（AMEGO_RELAY_URL 通過 https ／ 可從外部連到的檢查，
 * AMEGO_RELAY_SECRET 非空）才會改走中繼；缺一律直連，一個位元組都不變 ——
 * 見 amegoTransport()，syncAmegoClock() 與 amegoRequest() 都只透過它決定
 * 目的地，沒有第二個地方在做這個判斷。
 *
 * ⚠️ 中繼只換目的地 host、多帶一個 header，body（含 sign）逐位元組相同。
 *    sign 還是本機用 AMEGO_APP_KEY 算的（amegoSign()）——AppKey **不會**送給
 *    中繼、也不會出現在任何送給中繼的欄位或 header 裡；中繼只是把同一包
 *    x-www-form-urlencoded 封包轉送到 invoice-api.amego.tw，不參與、也不需要
 *    參與簽章。
 * ⚠️ AMEGO_RELAY_SECRET 只能出現在送給中繼的 header 裡，絕不可以流進任何
 *    console.* —— 比照 src/server/email.ts 對收件地址的規矩，靜態測試在
 *    scripts/amego-selftest.mjs。
 */
import { createHash } from "node:crypto";
import { isPubliclyReachableHost } from "./public-url.ts";

/** 測試與正式同一個網址；環境靠統編＋App Key 區分。 */
export const AMEGO_DEFAULT_BASE = "https://invoice-api.amego.tw";

/** 文件公開的測試憑證。放在程式碼裡是刻意的：它不是秘密，而且缺它時要能一眼看出。 */
export const AMEGO_TEST_BAN = "12345678";

/** 成功。其他一律是失敗，不管 HTTP 幾。 */
export const AMEGO_OK = 0;

/** 時間戳記錯誤 —— 唯一一個「校時後重送有機會成功」的錯誤碼。 */
export const AMEGO_CODE_TIME = 15;
/** 簽章錯誤。金鑰不對，重送一萬次都一樣。 */
export const AMEGO_CODE_SIGN = 16;
/** 查無資料。invoice_query 回這個代表「這張還沒開過」，是正常結果不是錯誤。 */
export const AMEGO_CODE_NOT_FOUND = 71;
/** OrderId 重複 —— 代表這張訂單已經開過發票了，是冪等訊號。 */
export const AMEGO_CODE_DUPLICATE_ORDER = 3040171;

/**
 * 載具號碼不存在。
 *
 * ⚠️ 這個碼不是「格式不對」，是「這個載具在財政部那邊查無此號」——本地的格式檢查
 * （src/lib/invoice-format.ts）永遠擋不到它，只有 Amego 知道。實測：測試環境對
 * **任何**載具都回這個碼（手機條碼 /ABC1234、/AAA0001、自然人憑證
 * AB12345678901234 全部一樣），正式環境則只有真的不存在的號碼會中。
 *
 * 它被 isPermanentAmegoError() 判為永久失敗是對的（重試同一個載具永遠是同一個答案），
 * 但「永久失敗」在這裡不可以等於「這張訂單沒有發票」——見 isCarrierRejection()。
 */
export const AMEGO_CODE_CARRIER_NOT_FOUND = 3040132;

/**
 * 這個錯誤是不是「只要把載具拿掉就開得出來」。
 *
 * 分出這一類的理由：客人打錯載具的代價不該是「完全沒有發票」。載具只決定這張發票
 * 存在哪裡，不決定它存不存在；拿掉載具照 B2C 開，客人至少拿得到憑證，而且之後還能
 * 拿發票號碼去財政部平台自己歸戶。反過來把它當成一般的永久失敗，retry_count 直接
 * 推到上限，這張訂單就要等人工介入才有發票 —— 而人工介入的觸發條件是「有人去看
 * invoice_backlog()」。
 */
export function isCarrierRejection(code: number | null): boolean {
  return code === AMEGO_CODE_CARRIER_NOT_FOUND;
}

/** 無統編時的買方統編固定值（不是空字串）。 */
export const ANONYMOUS_BUYER_ID = "0000000000";
/** 無統編時的買方名稱。⚠️ 不可填 0/00/000/0000，會被擋 3040123。 */
export const ANONYMOUS_BUYER_NAME = "消費者";

/** 應稅。本站沒有免稅（3）或零稅率（2）商品，但計算函式三種都支援。 */
export const TAX_TYPE_TAXABLE = "1";
export const TAX_TYPE_ZERO = "2";
export const TAX_TYPE_FREE = "3";

/** 營業稅率。字串形式是 API 要的格式（5% 寫 "0.05"）。 */
export const TAX_RATE = "0.05";

// -----------------------------------------------------------------------------
// 設定
// -----------------------------------------------------------------------------

export function amegoBase(): string {
  return (process.env.AMEGO_API_BASE ?? AMEGO_DEFAULT_BASE).replace(/\/+$/, "");
}

/** 賣方統編。這是「用哪個環境」的開關 —— 12345678 是文件公開的測試統編。 */
export function amegoBan(): string {
  return (process.env.AMEGO_INVOICE_BAN ?? "").trim();
}

export function amegoAppKey(): string {
  return (process.env.AMEGO_APP_KEY ?? "").trim();
}

/**
 * 是否設定完整到可以開發票。
 *
 * 與 payuniConfigured() 同樣的 fail-safe 精神：缺設定時回 false，呼叫端就把這一步
 * 整個跳過並留下待處理紀錄，而不是帶著空字串去打 API、拿到 code 16、把 retry_count
 * 燒到上限、最後變成一張「永久失敗」的發票。設定沒到位是運維問題，不該表現成資料問題。
 */
export function amegoConfigured(): boolean {
  return amegoBan().length > 0 && amegoAppKey().length > 0;
}

/** 是不是還在用文件公開的測試統編。上線前的檢查點，也讓 log 看得出環境。 */
export function amegoIsTestEnv(): boolean {
  return amegoBan() === AMEGO_TEST_BAN;
}

// -----------------------------------------------------------------------------
// 中繼（可選）
// -----------------------------------------------------------------------------
//
// 詳見檔頭「中繼（可選）」那一段。這裡只放設定的讀取與驗證；實際切換發生在
// amegoTransport()，它是 syncAmegoClock() 與 amegoRequest() 唯一共用的入口——
// 兩邊都要走同一條路徑，否則校時失敗（GET /json/time 一樣會被同一道 IP 白名單
// 擋下）會讓中繼在時鐘漂移那一刻形同虛設。

/**
 * 帶密鑰用的 header 名稱。
 *
 * 🔴 這個字串**必須**與 Railway 上那支中繼讀的名字逐字相同——它讀的是
 *    `req.headers["x-relay-secret"]`（見中繼的 server.js，那一行沒有做大小寫以外的
 *    正規化）。名字對不上的症狀是中繼回 401，而畫面上看起來就只是「發票又開不出來」，
 *    跟原本的 IP 問題長得一模一樣，很難分辨。改這個字串之前先去確認中繼那一側。
 */
export const AMEGO_RELAY_SECRET_HEADER = "x-relay-secret";

/**
 * 中繼服務網址（結尾沒有斜線）。沒設、格式不對、非 https、或主機從外部連不到
 * （localhost / 127.0.0.1 / *.local…），一律回 null。
 *
 * 呼叫端（amegoTransport()）把 null 當「沒設」處理，也就是走原本的直連——與
 * public-url.ts 的 publicSiteUrl() 同一個 fail-safe 精神：寧可退回一個已知能動
 * 的行為，也不要帶著一個連不到的網址去打，把「可以重試」的失敗變成「連中繼都
 * 連不上」的第二個問題。
 *
 * 判準借 isPubliclyReachableHost()，但不能直接呼叫 publicSiteUrl() 本人——
 * 那支讀的是 SITE_URL，這裡要驗的是另一個環境變數 AMEGO_RELAY_URL。
 */
export function amegoRelayUrl(): string | null {
  const raw = (process.env.AMEGO_RELAY_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error(`[amego] AMEGO_RELAY_URL 不是合法網址，改走直連。原始值="${raw}"`);
    return null;
  }
  if (url.protocol !== "https:" || !isPubliclyReachableHost(url.hostname)) {
    console.error(
      `[amego] AMEGO_RELAY_URL 必須是 https 且主機要能從外部連到，改走直連。原始值="${raw}"`,
    );
    return null;
  }
  return raw;
}

/**
 * 中繼密鑰。
 *
 * ⚠️ 這支函式的回傳值只准流進 amegoTransport() 組出來的 header —— 不可以出現
 *    在任何 console.* 呼叫裡（比照 email.ts 對收件地址的規矩）。
 */
export function amegoRelaySecret(): string {
  return (process.env.AMEGO_RELAY_SECRET ?? "").trim();
}

/** 兩個環境變數都設好、且網址通過檢查，才算「開啟中繼」；缺一律直連。 */
export function amegoRelayConfigured(): boolean {
  return amegoRelayUrl() !== null && amegoRelaySecret().length > 0;
}

/**
 * 這一次要打的目的地是直連還是中繼，以及要多帶哪些 header。
 *
 * syncAmegoClock() 與 amegoRequest() 都只透過這支函式決定「打去哪裡」——各自
 * 呼叫一次（沒有跨函式共用一份），代價是設定沒到位時可能重複印一次上面那兩條
 * console.error，換來的是兩支函式各自獨立，不必為了省一次 env 讀取而互相依賴。
 *
 * ⚠️ 不算 sign，也不碰 AppKey——呼叫端已經用 buildAmegoBody() 把 sign 算好帶在
 *    body 裡了。中繼只是換目的地 host、多帶一個 header，body 逐位元組相同，
 *    AppKey 永遠不會流到這支函式，中繼也就永遠拿不到它。
 */
export function amegoTransport(): { base: string; extraHeaders: Record<string, string> } {
  const relayUrl = amegoRelayUrl();
  const relaySecret = amegoRelaySecret();
  if (relayUrl !== null && relaySecret.length > 0) {
    console.info(`[amego] 兩個環境變數都設好，透過中繼呼叫: ${relayUrl}`);
    return { base: relayUrl, extraHeaders: { [AMEGO_RELAY_SECRET_HEADER]: relaySecret } };
  }
  return { base: amegoBase(), extraHeaders: {} };
}

// -----------------------------------------------------------------------------
// 簽章
// -----------------------------------------------------------------------------

/**
 * sign = md5(data 的 JSON 字串 + time + AppKey)。
 *
 * ⚠️ 串接的是**未經 url encode** 的 JSON 字串。body 裡的 `data` 會被 url encode
 * （URLSearchParams 自動做，伺服器收到後先 url decode 再驗簽），但簽章算的是
 * decode 後的原字串。拿 encode 過的字串去算，會得到 code 16 而且完全看不出為什麼。
 *
 * 也因為簽的是「那個字串」而不是「那個物件」，呼叫端必須把同一個字串同時交給
 * amegoSign() 與 body，不可以 JSON.stringify() 兩次 —— 物件的鍵序沒有保證。
 * amegoRequest() 就是這樣做的。
 */
export function amegoSign(dataJson: string, time: number | string, appKey: string): string {
  return createHash("md5").update(`${dataJson}${time}${appKey}`, "utf8").digest("hex");
}

/** 組出四個欄位的 form body。分開一支函式是為了讓 selftest 驗得到欄位與簽章。 */
export function buildAmegoBody(params: {
  ban: string;
  dataJson: string;
  time: number;
  appKey: string;
}): URLSearchParams {
  return new URLSearchParams({
    invoice: params.ban,
    data: params.dataJson,
    time: String(params.time),
    sign: amegoSign(params.dataJson, params.time, params.appKey),
  });
}

// -----------------------------------------------------------------------------
// 金額
// -----------------------------------------------------------------------------

export type InvoiceLine = {
  /** 品名。API 有長度限制，過長會被擋，所以在這裡就截斷。 */
  description: string;
  quantity: number;
  /** 含稅單價（TWD 整數）。折扣列用負數，官方範例就是這樣做的。 */
  unitPrice: number;
  /** 小計 = quantity × unitPrice。分開帶是因為 API 要，不是因為它可以不一致。 */
  amount: number;
  taxType?: typeof TAX_TYPE_TAXABLE | typeof TAX_TYPE_ZERO | typeof TAX_TYPE_FREE;
};

export type InvoiceAmounts = {
  salesAmount: number;
  freeTaxSalesAmount: number;
  zeroTaxSalesAmount: number;
  taxAmount: number;
  totalAmount: number;
};

/**
 * 依 Amego 規則算金額。**這一段不要自己推導。**
 *
 * 預設 DetailVat=1：單價與小計都是含稅價（台灣零售標價的慣例，本站的 products.price
 * 也是含稅價，所以兩邊天然一致）。
 *
 *   SalesAmount        = Round(所有 TaxType=1 的 Amount 加總)
 *   FreeTaxSalesAmount = Round(所有 TaxType=3 的 Amount 加總)
 *   ZeroTaxSalesAmount = Round(所有 TaxType=2 的 Amount 加總)
 *
 *   不打統編：TaxAmount = 0                            ← 稅額一律 0，完全不分拆
 *   打統編：  TaxAmount   = SalesAmount - Round(SalesAmount / 1.05)
 *             SalesAmount = SalesAmount - TaxAmount     ← 注意 SalesAmount 會被覆寫
 *
 *   TotalAmount = SalesAmount + FreeTaxSalesAmount + ZeroTaxSalesAmount + TaxAmount
 *
 * 「有打統編才分拆 5% 稅額，沒打統編一律帶 0」是這家 API 最反直覺的一條。直覺會說
 * 「含稅價 100 的發票，稅額當然是 5」，但 B2C 發票在 Amego 這裡就是 sales=100 tax=0
 * total=100（實測 ZA10034112 的 invoice_query 回來就是這三個數）。照直覺寫會拿到
 * `3040178 TotalAmount 計算錯誤`，而且是每一張都錯。
 *
 * TotalAmount 在兩種情況下都等於「所有明細加總」，這是 assertAmountsMatchOrder()
 * 可以直接拿 orders.total 來對的原因。
 */
export function computeInvoiceAmounts(
  lines: InvoiceLine[],
  options: { hasTaxId: boolean },
): InvoiceAmounts {
  const sumOf = (taxType: string) =>
    Math.round(
      lines
        .filter((l) => (l.taxType ?? TAX_TYPE_TAXABLE) === taxType)
        .reduce((acc, l) => acc + l.amount, 0),
    );

  let salesAmount = sumOf(TAX_TYPE_TAXABLE);
  const freeTaxSalesAmount = sumOf(TAX_TYPE_FREE);
  const zeroTaxSalesAmount = sumOf(TAX_TYPE_ZERO);

  let taxAmount = 0;
  if (options.hasTaxId) {
    taxAmount = salesAmount - Math.round(salesAmount / 1.05);
    salesAmount = salesAmount - taxAmount;
  }

  return {
    salesAmount,
    freeTaxSalesAmount,
    zeroTaxSalesAmount,
    taxAmount,
    totalAmount: salesAmount + freeTaxSalesAmount + zeroTaxSalesAmount + taxAmount,
  };
}

/**
 * 台灣統一編號檢核碼。
 *
 * 在送出前擋掉格式錯的統編，而不是讓 Amego 回 3040122 —— 因為那個失敗是永久性的，
 * 會把 retry_count 燒到上限，然後這張訂單就永遠開不出發票，除非有人手動改資料。
 * 在本地擋下來的話，呼叫端可以選擇「當成沒有統編、照 B2C 開」，客人至少拿得到發票。
 *
 * ⚠️ 只用來檢查**買方**統編。Amego 自己的測試賣方統編 12345678 通不過這個檢核
 * （加權和 42，不是 5 的倍數），拿去檢查 AMEGO_INVOICE_BAN 會讓整個測試環境開不了票。
 *
 * 規則（財政部）：8 碼數字，乘數 [1,2,1,2,1,2,4,1]，每位乘積的十位與個位相加後總和，
 * 能被 5 整除即有效；第 7 碼為 7 時，該位的乘積可視為 10（即總和 +1 也算過）。
 */
export function isValidTaxId(value: string): boolean {
  const id = (value ?? "").trim();
  if (!/^\d{8}$/.test(id)) return false;
  const weights = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const product = Number(id[i]) * weights[i];
    sum += Math.floor(product / 10) + (product % 10);
  }
  if (sum % 5 === 0) return true;
  // 第 7 碼是 7 的特例：該位乘積 28 可改記為 10，等於總和 +1。
  return id[6] === "7" && (sum + 1) % 5 === 0;
}

// -----------------------------------------------------------------------------
// 傳輸
// -----------------------------------------------------------------------------

export type AmegoResponse = {
  code: number;
  msg: string;
  [key: string]: unknown;
};

export type AmegoResult =
  | { ok: true; data: AmegoResponse }
  /** 有回應但業務失敗。retryable 決定要不要再打一次，permanent 的一律不要。 */
  | { ok: false; kind: "business"; code: number; msg: string; data: AmegoResponse }
  /** 連不上、逾時、回了不是 JSON 的東西。這一類重試有意義。 */
  | { ok: false; kind: "transport"; code: null; msg: string };

/**
 * 與 Amego 伺服器的時間差（秒）。收到 code 15 才會被設定。
 *
 * 模組層級的變數：同一個 serverless instance 在冷啟動之後只會校時一次，之後所有
 * 呼叫都自動帶上 offset。跨 instance 不共用，但每個 instance 最多也只多付一次往返。
 */
let clockOffsetSeconds = 0;

/** 測試用：把校時狀態清乾淨，讓每個 case 從同一個起點跑。 */
export function resetAmegoClockOffset(): void {
  clockOffsetSeconds = 0;
}

export function amegoClockOffset(): number {
  return clockOffsetSeconds;
}

/** 現在要送出的 timestamp（本機時間 + 已知 offset）。 */
export function amegoNow(): number {
  return Math.floor(Date.now() / 1000) + clockOffsetSeconds;
}

/**
 * 向 Amego 校時，並記住 offset。
 *
 * GET /json/time 不需簽章也不需任何參數 —— 簽章失敗時第一個該查的就是它。
 * 回傳新的 offset（秒）；本機時間比伺服器慢時為正。
 */
export async function syncAmegoClock(timeoutMs = 10_000): Promise<number> {
  const { base, extraHeaders } = amegoTransport();
  const res = await fetchWithTimeout(
    `${base}/json/time`,
    { method: "GET", headers: extraHeaders },
    timeoutMs,
  );
  const body = (await res.json()) as { timestamp?: number };
  if (typeof body.timestamp !== "number") {
    throw new Error(`[amego] /json/time 回應沒有 timestamp: ${JSON.stringify(body)}`);
  }
  clockOffsetSeconds = body.timestamp - Math.floor(Date.now() / 1000);
  return clockOffsetSeconds;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  // ⚠️ abort() 要帶 reason。不帶的話 fetch 丟出來的是訊息空白的 AbortError，
  // 錯誤紀錄裡「逾時」與「連不上」長得一模一樣。
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout_after_${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 fetch 的失敗攤成看得懂的一行。
 *
 * ⚠️ Node 的 fetch 失敗時 `err.message` 只有 "fetch failed" 這幾個字——真正的原因
 * （ECONNREFUSED、ENOTFOUND、憑證錯誤、連線逾時）藏在 `err.cause` 裡，而且常常再包
 * 一層（TypeError → AggregateError → 帶 errno 的 Error）。只讀 message 的話，正式站上
 * 的紀錄會是一句沒有內容的字串，查不出任何東西。
 */
export function describeFetchFailure(err: unknown, depth = 0): string {
  if (err == null) return "unknown_error";
  if (!(err instanceof Error)) return String(err);

  const name = err.name || "Error";
  let line = err.message ? `${name}: ${err.message}` : name;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") line += ` code=${code}`;

  if (depth >= 3) return line;
  // AggregateError（IPv4／IPv6 都連不上時 undici 會丟這個）真正的原因在 errors 裡，
  // 不在 cause 裡——只看 cause 會拿到 undefined。
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return `${line} [${errors.map((e) => describeFetchFailure(e, depth + 1)).join(" | ")}]`;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause != null) return `${line} <- ${describeFetchFailure(cause, depth + 1)}`;
  return line;
}

/**
 * 打一支 Amego API。
 *
 * `data` 直接吃物件或陣列，因為端點各自要哪一種是 API 的事實，不是呼叫端該記的。
 *
 * 時鐘處理在這裡：第一次用本機時間送；只有在收到 code 15（time 錯誤）時才校時並
 * **重送一次**。之所以不是「每次都先校時」——那會讓每張發票都多一次往返，而且
 * /json/time 自己掛掉時反而變成開不出發票。之所以不是「不處理」——時鐘漂移會讓
 * 所有發票同時開不出來，而且錯誤訊息（sign 相關）完全指不到真正的原因。
 */
export async function amegoRequest(
  path: string,
  data: unknown,
  options: { timeoutMs?: number; allowRetryOnTimeSkew?: boolean } = {},
): Promise<AmegoResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const ban = amegoBan();
  const appKey = amegoAppKey();
  if (!ban || !appKey) {
    return { ok: false, kind: "transport", code: null, msg: "amego_not_configured" };
  }

  // 只序列化一次：簽章與 body 必須是**同一個字串**，物件的鍵序沒有保證。
  const dataJson = JSON.stringify(data);
  // 直連還是中繼，在這裡決定一次；下面 send() 每次重送（時鐘校正後）都用同一個
  // 目的地，不會第一次直連、重送又變成中繼。
  const transport = amegoTransport();

  const send = async (time: number): Promise<AmegoResult> => {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${transport.base}${path}`,
        {
          method: "POST",
          // ⚠️ 絕不可用 application/json：伺服器解析不到欄位，會回 code 11。
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...transport.extraHeaders,
          },
          body: buildAmegoBody({ ban, dataJson, time, appKey }),
        },
        timeoutMs,
      );
    } catch (err) {
      return {
        ok: false,
        kind: "transport",
        code: null,
        msg: describeFetchFailure(err),
      };
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // HTTP 200 但不是 JSON（維護頁、WAF 擋頁）也算傳輸層失敗，重試有意義。
      return {
        ok: false,
        kind: "transport",
        code: null,
        msg: `non_json_response http=${res.status} body=${text.slice(0, 200)}`,
      };
    }

    // 🔴 JSON 解得開 ≠ 這是 Amego 的回應。中繼自己的錯誤（path_not_allowed、
    // unauthorized）也是合法 JSON，只是沒有 code 欄位。這裡以前直接 `as AmegoResponse`
    // 就去讀 body.code，undefined 一路往下傳：訊息變成 `code=transport msg=`（連一個字
    // 都沒有），而且 isPermanentAmegoError(undefined) 會回 true——因為它只擋 null——
    // 於是被判成永久失敗、不再重試。2026-09 有 5 張發票就是這樣卡住，而且從紀錄上完全
    // 看不出中繼回的是 404。沒有 number 型別的 code 一律當傳輸層失敗，並把 HTTP 狀態碼
    // 與回應內容原樣帶出去。
    const body = parsed as Partial<AmegoResponse> | null;
    if (typeof body?.code !== "number") {
      return {
        ok: false,
        kind: "transport",
        code: null,
        msg: `unexpected_response http=${res.status} body=${text.slice(0, 200)}`,
      };
    }

    const full = body as AmegoResponse;
    if (full.code === AMEGO_OK) return { ok: true, data: full };
    return { ok: false, kind: "business", code: full.code, msg: full.msg ?? "", data: full };
  };

  const first = await send(amegoNow());
  if (
    first.ok ||
    first.kind !== "business" ||
    first.code !== AMEGO_CODE_TIME ||
    options.allowRetryOnTimeSkew === false
  ) {
    return first;
  }

  // code 15：本機時鐘與 Amego 差超過 ±60 秒。校時後重送一次，並記住 offset。
  try {
    const offset = await syncAmegoClock(timeoutMs);
    console.warn(`[amego] 時鐘漂移已校正 offset=${offset}s（本機時間與 Amego 相差這麼多秒）`);
  } catch (err) {
    console.error("[amego] /json/time 校時失敗", err);
    return first;
  }
  return send(amegoNow());
}

// -----------------------------------------------------------------------------
// 業務 API
// -----------------------------------------------------------------------------

export type IssueInvoiceInput = {
  /** ≤40 字、不可重複。用 orders.order_no —— 它本來就唯一，天然是冪等鍵。 */
  orderId: string;
  /** 有統編就填，沒有留空。空值會自動代換成 0000000000。 */
  taxId?: string | null;
  /** 有統編時填公司抬頭；沒有時留空會自動代換成「消費者」。 */
  buyerName?: string | null;
  buyerEmail?: string | null;
  lines: InvoiceLine[];
  /** 手機條碼 3J0002 / 自然人憑證 CQ0001 / 光貿會員載具 amego。 */
  carrierType?: string | null;
  carrierId?: string | null;
  /** 捐贈碼。與載具互斥。 */
  loveCode?: string | null;
};

export type IssuedInvoice = {
  invoiceNumber: string;
  randomNumber: string;
  invoiceTime: number;
  barcode?: string;
  qrcodeLeft?: string;
  qrcodeRight?: string;
};

/**
 * 組 /json/f0401 的 data。純函式，selftest 直接驗。
 *
 * 所有數字都轉成字串：API 的欄位型別是字串，送數字會被某些欄位拒絕，而且送出去之前
 * 就統一成字串比「有些欄位字串、有些數字」好除錯。
 *
 * 打統編時 BuyerName 一定要有東西（3040123），所以抬頭沒填時退回買方姓名再退回
 * 「消費者」——寧可抬頭不完美，也不要一張開不出來的發票。
 */
export function buildIssuePayload(input: IssueInvoiceInput): Record<string, unknown> {
  const taxId = (input.taxId ?? "").trim();
  const hasTaxId = taxId.length > 0;
  const amounts = computeInvoiceAmounts(input.lines, { hasTaxId });

  const payload: Record<string, unknown> = {
    OrderId: input.orderId,
    BuyerIdentifier: hasTaxId ? taxId : ANONYMOUS_BUYER_ID,
    BuyerName: (input.buyerName ?? "").trim() || ANONYMOUS_BUYER_NAME,
    ProductItem: input.lines.map((line) => ({
      Description: line.description,
      Quantity: String(line.quantity),
      UnitPrice: String(line.unitPrice),
      Amount: String(line.amount),
      TaxType: line.taxType ?? TAX_TYPE_TAXABLE,
    })),
    SalesAmount: String(amounts.salesAmount),
    FreeTaxSalesAmount: String(amounts.freeTaxSalesAmount),
    ZeroTaxSalesAmount: String(amounts.zeroTaxSalesAmount),
    TaxType: TAX_TYPE_TAXABLE,
    TaxRate: TAX_RATE,
    TaxAmount: String(amounts.taxAmount),
    TotalAmount: String(amounts.totalAmount),
  };

  const email = (input.buyerEmail ?? "").trim();
  if (email) payload.BuyerEmailAddress = email;

  // 載具與捐贈互斥，而且都只在「沒有統編」時才成立（B2B 發票沒有載具可言）。
  const loveCode = (input.loveCode ?? "").trim();
  const carrierType = (input.carrierType ?? "").trim();
  const carrierId = (input.carrierId ?? "").trim();
  if (!hasTaxId && loveCode) {
    payload.NPOBAN = loveCode;
  } else if (!hasTaxId && carrierType && carrierId) {
    payload.CarrierType = carrierType;
    payload.CarrierId1 = carrierId;
    payload.CarrierId2 = carrierId;
  }

  return payload;
}

/**
 * 業務錯誤碼是不是「重試也不會變」。
 *
 * 判斷錯的兩個方向後果不對稱：把永久失敗當成可重試，會拿同一張壞資料去敲 Amego
 * 直到 retry 上限（只是浪費）；把可重試當成永久失敗，客人的發票就永遠不會開出來
 * （要人工處理）。所以這裡採白名單制：**只有明確知道重試有機會成功的才算可重試**，
 * 其餘一律永久 —— 寧可停下來讓人看見，也不要無限重試一個開不出來的東西。
 */
export function isPermanentAmegoError(code: number | null): boolean {
  if (code === null) return false; // 傳輸層失敗，一律可重試
  // 15 校時後有機會成功（amegoRequest 已經自己重送過一次，這裡是它仍失敗的情況，
  // 例如 /json/time 當下也連不上）；其餘業務錯誤碼都是資料或設定問題。
  return code !== AMEGO_CODE_TIME;
}

/** 開立發票（自動配號）。 */
export async function issueInvoice(
  input: IssueInvoiceInput,
): Promise<AmegoResult & { invoice?: IssuedInvoice }> {
  const result = await amegoRequest("/json/f0401", buildIssuePayload(input));
  if (!result.ok) return result;
  const d = result.data;
  return {
    ...result,
    invoice: {
      invoiceNumber: String(d.invoice_number ?? ""),
      randomNumber: String(d.random_number ?? ""),
      invoiceTime: Number(d.invoice_time ?? 0),
      barcode: d.barcode === undefined ? undefined : String(d.barcode),
      qrcodeLeft: d.qrcode_left === undefined ? undefined : String(d.qrcode_left),
      qrcodeRight: d.qrcode_right === undefined ? undefined : String(d.qrcode_right),
    },
  };
}

/** Ymd（Asia/Taipei）。發票日期是台灣的日期，不是 UTC 的。 */
export function taipeiYmd(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return parts.replace(/-/g, "");
}

/**
 * 作廢發票。
 *
 * ⚠️ 這支 API **只吃陣列**（物件會得到 `3050112 …應為陣列字串`）。介面留單張，
 * 因為呼叫端永遠是「作廢這一張」，批次是 API 的細節不是業務需求。
 */
export async function voidInvoice(params: {
  invoiceNumber: string;
  /** 原發票開立日期 Ymd。抓不到時用今天 —— Amego 會自己核對，錯了會回 3050125。 */
  invoiceDate?: string;
  reason: string;
}): Promise<AmegoResult> {
  const today = taipeiYmd();
  return amegoRequest("/json/f0501", [
    {
      CancelInvoiceNumber: params.invoiceNumber,
      InvoiceDate: params.invoiceDate ?? today,
      CancelDate: today,
      CancelReason: params.reason.slice(0, 20),
    },
  ]);
}

export type InvoiceQueryHit = {
  invoiceNumber: string;
  randomNumber: string;
  invoiceType: string;
  totalAmount: number;
  /** 已經送出作廢但還沒完成時，wait 會有一筆 C0501。 */
  pendingVoid: boolean;
};

/**
 * 用 OrderId 反查發票。
 *
 * 這是「重試前先確認有沒有開過」的那一支 —— OrderId 在 Amego 那邊唯一，所以任何
 * 重試路徑都先問它一次，避免「上一次其實開成功了，只是我們沒記到」變成開第二張。
 *
 * 回 null 代表查無資料（code 71），也就是還沒開過；那是正常結果，不是錯誤。
 */
export async function findInvoiceByOrderId(
  orderId: string,
): Promise<{ ok: true; hit: InvoiceQueryHit | null } | { ok: false; msg: string }> {
  const result = await amegoRequest("/json/invoice_query", { type: "order", order_id: orderId });
  if (result.ok) {
    const d = (result.data.data ?? {}) as Record<string, unknown>;
    const wait = Array.isArray(d.wait) ? (d.wait as Record<string, unknown>[]) : [];
    return {
      ok: true,
      hit: {
        invoiceNumber: String(d.invoice_number ?? ""),
        randomNumber: String(d.random_number ?? ""),
        invoiceType: String(d.invoice_type ?? ""),
        totalAmount: Number(d.total_amount ?? 0),
        pendingVoid: wait.some((w) => String(w.invoice_type ?? "") === "C0501"),
      },
    };
  }
  if (result.kind === "business" && result.code === AMEGO_CODE_NOT_FOUND) {
    return { ok: true, hit: null };
  }
  return { ok: false, msg: `code=${result.kind === "business" ? result.code : "-"} ${result.msg}` };
}
