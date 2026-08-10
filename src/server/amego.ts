/**
 * 光貿 Amego 電子發票 —— 簽章、金額計算、開立／作廢／查詢。
 *
 * ── 這個檔案為什麼不 import 任何專案模組 ────────────────────────────────────
 * 與 src/server/payuni.ts 同一個理由：只依賴 node:crypto，scripts/amego-selftest.mjs
 * 才能不經過 bundler、不經過 tsconfig paths，直接 import「產線上真正跑的那一份」
 * 用測試向量驗證。驗一份複製品等於沒驗。保護改由檔案位置提供：vite 設定把
 * `**\/server\/**` 列入 client importProtection（behavior: "error"），任何 client
 * 端模組 import 到這裡都會直接讓 build 失敗。
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
 */
import { createHash } from "node:crypto";

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
  const res = await fetchWithTimeout(`${amegoBase()}/json/time`, { method: "GET" }, timeoutMs);
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

  const send = async (time: number): Promise<AmegoResult> => {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${amegoBase()}${path}`,
        {
          method: "POST",
          // ⚠️ 絕不可用 application/json：伺服器解析不到欄位，會回 code 11。
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: buildAmegoBody({ ban, dataJson, time, appKey }),
        },
        timeoutMs,
      );
    } catch (err) {
      return {
        ok: false,
        kind: "transport",
        code: null,
        msg: err instanceof Error ? err.message : String(err),
      };
    }

    const text = await res.text();
    let body: AmegoResponse;
    try {
      body = JSON.parse(text) as AmegoResponse;
    } catch {
      // HTTP 200 但不是 JSON（維護頁、WAF 擋頁）也算傳輸層失敗，重試有意義。
      return {
        ok: false,
        kind: "transport",
        code: null,
        msg: `non_json_response http=${res.status} body=${text.slice(0, 200)}`,
      };
    }

    if (body.code === AMEGO_OK) return { ok: true, data: body };
    return { ok: false, kind: "business", code: body.code, msg: body.msg ?? "", data: body };
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
