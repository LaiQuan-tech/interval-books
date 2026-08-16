/**
 * Gemini —— 拍照辨識（OCR）唯一的對外出口。
 *
 * ── 為什麼不是 edge function ───────────────────────────────────────────────
 * 來源進銷存把辨識放在兩支 Supabase Edge Function 裡（recognize-purchase-order、
 * recognize-product），它們打的是 Lovable AI Gateway。這個專案**一支 edge
 * function 都沒有**，而 Vercel 本來就跑 Node —— 多一個 Deno runtime 就多一份
 * 部署、一份金鑰、一份 CORS 設定要顧。所以辨識走 createServerFn + 這個模組。
 *
 * ── 這一層的三條規矩 ──────────────────────────────────────────────────────
 * 1. **不收 base64。** 呼叫端給的是私有 bucket 的 storage key，圖從 storage 讀。
 *    來源是把整張 data URL 塞進 request body（一張手機照 5.4MB），Vercel 的
 *    body 上限大約 4.5MB —— 那條路在這個平台上本來就走不通。
 * 2. **回傳一定是結構化的。** 用 responseSchema 讓模型直接吐 JSON，不做
 *    「抓第一個 { 到最後一個 }」的正則（來源 recognize-purchase-order:130 的做法，
 *    模型多講一句帶大括號的話就會壞）。
 * 3. **失敗一定分得出種類。** 額度、逾時、格式壞掉是三種不同的處置，店員要看到
 *    不同的話。來源的進貨單那一支把 429 跟 500 混成同一句「操作失敗」。
 *
 * ⚠️ 這個檔案只負責「問模型、拿回結構化答案」。它不寫任何一張表 —— 辨識結果要
 *    不要變成商品／進貨單，是店員在確認畫面上按下去之後，走 0016／0017 那些既有
 *    的 SECURITY DEFINER 函式。AI 沒有寫入權。
 */
import "@tanstack/react-start/server-only";
import { geminiApiKey, geminiOcrModel } from "./env";
import { readOcrScan } from "./storage";

/** 辨識失敗的分類。前端據此決定要說什麼、要不要建議改手動輸入。 */
export type OcrFailureKind =
  | "quota" // 429/402：額度或頻率
  | "timeout" // 逾時
  | "bad_response" // 模型回了東西，但不是我們要的形狀
  | "no_content" // 模型什麼都沒認出來（圖太模糊、根本不是單據）
  | "service"; // 其他（5xx、網路）

export class OcrError extends Error {
  readonly kind: OcrFailureKind;
  constructor(kind: OcrFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** 超過這個時間就放棄。店員盯著轉圈圈超過半分鐘會直接關掉視窗，那比一句錯誤訊息更糟。 */
const TIMEOUT_MS = 30_000;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

// ---------------------------------------------------------------------------
// 回傳的形狀
// ---------------------------------------------------------------------------

export type OcrPurchaseItem = {
  name: string;
  issue_number: string | null;
  series: string | null;
  quantity: number;
  unit_cost: number;
};

export type OcrPurchaseResult = {
  vendor: string | null;
  purchase_date: string | null;
  items: OcrPurchaseItem[];
  notes: string | null;
};

export type OcrBookResult = {
  name: string;
  issue_number: string | null;
  series: string | null;
  publisher: string | null;
  barcode: string | null;
  detected_text: string | null;
  confidence: "high" | "medium" | "low" | "none";
};

// ---------------------------------------------------------------------------
// responseSchema —— 讓模型自己保證形狀
// ---------------------------------------------------------------------------
// 每一個欄位都 nullable，而且沒有一個是 required 之外的東西。理由：模型認不出
// 廠商時應該回 null，不是憑空編一個。來源的 prompt 寫「如果某些欄位無法辨識，
// 請留空或**給予合理推測**」—— 進貨單的單價不該有推測這種東西。

const PURCHASE_SCHEMA = {
  type: "OBJECT",
  properties: {
    vendor: { type: "STRING", nullable: true, description: "廠商名稱，認不出來就 null" },
    purchase_date: {
      type: "STRING",
      nullable: true,
      description: "進貨日期，格式 YYYY-MM-DD。認不出來就 null，不要用今天的日期填補",
    },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "商品名稱，不含期數" },
          issue_number: { type: "STRING", nullable: true, description: "期數，只要數字部分" },
          series: { type: "STRING", nullable: true, description: "系列名稱" },
          quantity: { type: "INTEGER", description: "數量" },
          unit_cost: { type: "NUMBER", description: "單價（進貨成本）" },
        },
        required: ["name", "quantity", "unit_cost"],
      },
    },
    notes: { type: "STRING", nullable: true, description: "單據上的其他備註" },
  },
  required: ["items"],
} as const;

const BOOK_SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING", description: "書名／商品名稱，不含期數" },
    issue_number: { type: "STRING", nullable: true, description: "期數，只要數字部分" },
    series: { type: "STRING", nullable: true, description: "系列名稱" },
    publisher: { type: "STRING", nullable: true, description: "出版社" },
    barcode: { type: "STRING", nullable: true, description: "ISBN 或條碼，只要數字" },
    detected_text: { type: "STRING", nullable: true, description: "封面上讀到的文字" },
    confidence: { type: "STRING", enum: ["high", "medium", "low", "none"] },
  },
  required: ["name", "confidence"],
} as const;

// ---------------------------------------------------------------------------
// 送出
// ---------------------------------------------------------------------------

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

async function callGemini(
  parts: GeminiPart[],
  responseSchema: unknown,
  systemInstruction: string,
): Promise<unknown> {
  const model = geminiOcrModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      // 金鑰走 header，不走 query string —— 網址會進 log、進 error report。
      headers: { "x-goog-api-key": geminiApiKey(), "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema,
          // 辨識單據不需要創意。0 讓同一張圖每次回一樣的答案，店員回報問題時查得下去。
          temperature: 0,
        },
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new OcrError("timeout", "辨識逾時（超過 30 秒）。可以再試一次，或直接手動輸入。");
    }
    throw new OcrError("service", "無法連線到辨識服務，請改用手動輸入。");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // 來源的進貨單那一支只 throw 一句 `AI API error: ${status}`，於是額度用完跟
    // 伺服器掛掉在店員眼裡是同一句話。這裡分開。
    if (response.status === 429) {
      throw new OcrError("quota", "辨識服務目前忙碌（額度或頻率上限），請稍後再試或手動輸入。");
    }
    if (response.status === 402 || response.status === 403) {
      throw new OcrError("quota", "辨識服務的額度或金鑰有問題，請通知管理員。可以先手動輸入。");
    }
    throw new OcrError("service", `辨識服務暫時無法使用（${response.status}），請改用手動輸入。`);
  }

  let payload: {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new OcrError("bad_response", "辨識服務回了無法解析的內容，請重拍或手動輸入。");
  }

  const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    throw new OcrError("no_content", "這張圖沒有辨識出任何內容，請確認拍攝清晰度，或手動輸入。");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // responseSchema 理論上保證是合法 JSON，但「理論上」不是驗收條件。
    throw new OcrError("bad_response", "辨識結果的格式不正確，請重拍或手動輸入。");
  }
}

/** storage key → Gemini 要的 inline_data。圖從私有 bucket 讀，不經過瀏覽器。 */
async function imagePart(scanKey: string): Promise<GeminiPart> {
  const { bytes, contentType } = await readOcrScan(scanKey);
  return {
    inline_data: {
      mime_type: contentType,
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

// ---------------------------------------------------------------------------
// 進貨單
// ---------------------------------------------------------------------------

const PURCHASE_SYSTEM = [
  "你是進貨單辨識助手。從照片裡讀出廠商、日期與逐項的商品、數量、單價。",
  "規則：",
  "1. 只回報單子上真的看得到的資訊。看不清楚的欄位回 null，**不要推測**——",
  "   進貨單的單價被猜錯會直接變成錯誤的庫存成本。",
  "2. 期數（issue_number）可能寫成 #130、Vol.5、第3期、NO.50，只取數字部分。",
  "3. 商品名稱不要包含期數。",
  "4. 手寫字跡盡量辨識；真的判讀不了就不要放進 items。",
].join("\n");

export async function recognisePurchaseOrder(input: {
  scanKey: string;
  knownProducts: { name: string; issue_number: string | null; series: string | null }[];
}): Promise<OcrPurchaseResult> {
  // 已知商品清單當作比對提示。來源也有這一段，但它把全部 993 筆塞進 prompt；
  // 這裡由呼叫端截斷（見 fns/ocr.ts），太長的 prompt 會稀釋注意力也會變貴。
  const hint =
    input.knownProducts.length > 0
      ? "\n\n店裡已有的商品（辨識到相似的請盡量對齊寫法，注意期數與系列）：\n" +
        input.knownProducts
          .map(
            (p) =>
              p.name +
              (p.issue_number ? ` #${p.issue_number}` : "") +
              (p.series ? `（系列：${p.series}）` : ""),
          )
          .join("\n")
      : "";

  const parts: GeminiPart[] = [
    { text: `請辨識這張進貨單。${hint}` },
    await imagePart(input.scanKey),
  ];

  const raw = (await callGemini(parts, PURCHASE_SCHEMA, PURCHASE_SYSTEM)) as Record<
    string,
    unknown
  >;
  return normalisePurchase(raw);
}

/**
 * 把模型回的東西收成我們的型別。
 *
 * responseSchema 管形狀，這裡管**語意**：數量必須是正整數、單價不可為負、日期
 * 必須真的是 YYYY-MM-DD。模型再聽話也不是驗證器。
 */
function normalisePurchase(raw: Record<string, unknown>): OcrPurchaseResult {
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items: OcrPurchaseItem[] = [];

  for (const entry of rawItems) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name) continue;

    const quantity = Math.trunc(Number(e.quantity));
    const unitCost = Number(e.unit_cost);

    items.push({
      name: name.slice(0, 200),
      issue_number: cleanText(e.issue_number, 50),
      series: cleanText(e.series, 200),
      // 認不出來就當 1 件、成本 0 —— 讓店員在確認畫面上改，而不是整張單子退回去。
      quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(quantity, 99999) : 1,
      unit_cost: Number.isFinite(unitCost) && unitCost >= 0 ? Math.min(unitCost, 9999999) : 0,
    });
  }

  if (items.length === 0) {
    throw new OcrError(
      "no_content",
      "這張圖沒有讀出任何商品明細。請確認拍的是進貨單、字跡清晰，或直接手動建單。",
    );
  }

  const date = cleanText(raw.purchase_date, 10);
  return {
    vendor: cleanText(raw.vendor, 200),
    purchase_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    items: items.slice(0, 200),
    notes: cleanText(raw.notes, 1000),
  };
}

// ---------------------------------------------------------------------------
// 書封 / 商品
// ---------------------------------------------------------------------------

const BOOK_SYSTEM = [
  "你是書籍與商品辨識助手。從封面照片讀出書名、期數、系列、出版社與條碼。",
  "規則：",
  "1. 書名不要包含期數。期數可能寫成 #130、Vol.5、第3期、NO.50，只取數字部分。",
  "2. 看不清楚的欄位回 null，不要推測。",
  "3. confidence 誠實回報：整本都很清楚才是 high，只讀到零星字是 low，",
  "   完全看不出這是什麼就是 none。",
].join("\n");

export async function recogniseBook(input: { scanKey: string }): Promise<OcrBookResult> {
  const parts: GeminiPart[] = [
    { text: "請辨識這張商品／書籍照片。" },
    await imagePart(input.scanKey),
  ];

  const raw = (await callGemini(parts, BOOK_SCHEMA, BOOK_SYSTEM)) as Record<string, unknown>;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const confidence = ["high", "medium", "low", "none"].includes(String(raw.confidence))
    ? (raw.confidence as OcrBookResult["confidence"])
    : "low";

  if (!name || confidence === "none") {
    throw new OcrError("no_content", "這張圖沒有辨識出商品名稱。請靠近一點重拍，或直接手動輸入。");
  }

  return {
    name: name.slice(0, 200),
    issue_number: cleanText(raw.issue_number, 50),
    series: cleanText(raw.series, 200),
    publisher: cleanText(raw.publisher, 200),
    // 條碼只留數字。模型常常把 "ISBN 978-…" 整串回來。
    barcode: cleanText(raw.barcode, 50)?.replace(/\D/g, "") || null,
    detected_text: cleanText(raw.detected_text, 2000),
    confidence,
  };
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed.slice(0, max);
}
