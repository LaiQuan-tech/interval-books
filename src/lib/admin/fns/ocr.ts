/**
 * 拍照辨識（OCR）的 server functions。
 *
 * ── 兩支上傳、兩支辨識，中間隔著一個 storage key ──────────────────────────
 *
 *     瀏覽器：壓縮（ImageField 那條 pipeline）→ uploadOcrScan → 拿到 "ocr:…"
 *     瀏覽器：recognisePurchaseOrder({ scan_key })  ← **只送 key，不送圖**
 *     伺服器：從私有 bucket 讀圖 → Gemini → 結構化結果
 *
 * 為什麼要多這一跳：
 *   · Vercel serverless 的 request body 大約 4.5MB 就滿了，而 base64 會把圖脹大
 *     33%。來源是直接把整張 data URL（手機照 5.4MB）塞進 request body。
 *   · 辨識結果可疑時要調得出原圖對照。丟完就忘的話，「AI 說單價 50」永遠只能
 *     信或不信。
 *   · bucket 是**私有**的（0018）。進貨單上有廠商名稱、單價與聯絡方式。
 *
 * ── AI 沒有寫入權 ─────────────────────────────────────────────────────────
 * 這個檔案裡沒有任何一支會寫 inv.*。辨識結果是一份**建議**，要不要變成商品或
 * 進貨單，是店員在確認畫面上逐列改完再按下去，走 0016／0017 既有的
 * SECURITY DEFINER 函式。這一條不能鬆：模型讀錯一個單價就是錯誤的庫存成本。
 */
import { createServerFn } from "@tanstack/react-start";
import { staffFnMiddleware } from "@/lib/admin/middleware";
import { ocrRecogniseSchema } from "@/lib/admin/schemas";
import type { OcrFailureKindValue } from "@/lib/admin/schemas";

/**
 * 辨識的統一回傳。**失敗不 throw，回一個 ok:false**。
 *
 * 這與這個專案其他 server fn 的慣例（錯誤一律 throw）刻意不同，理由是失敗的
 * 種類會決定畫面要說什麼：額度用完要說「稍後再試」、逾時要說「可以重試」、
 * 圖看不懂要說「重拍或手動輸入」。throw 之後前端只剩一句字串可以比對，那正是
 * 來源那兩支 edge function 的下場（429 與 500 都變成「操作失敗，請稍後再試」）。
 *
 * ⚠️ 真正的授權失敗仍然是 throw（middleware 丟的），不會變成 ok:false。
 */
export type OcrResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: OcrFailureKindValue; message: string };

/** 上傳一張要辨識的圖。回一個 storage key，不回網址 —— bucket 是私有的。 */
export const uploadOcrScan = createServerFn({ method: "POST" })
  .inputValidator((data: FormData) => data)
  .middleware([staffFnMiddleware()])
  .handler(async ({ data }): Promise<{ key: string }> => {
    const file = data.get("file");
    if (!(file instanceof File)) {
      throw new Error("缺少要上傳的圖片");
    }
    const { uploadOcrScan } = await import("@/server/storage");
    return await uploadOcrScan(file);
  });

/** 回看原圖用的短期網址（30 分鐘）。私有 bucket 沒有永久網址。 */
export const getOcrScanUrl = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(ocrRecogniseSchema)
  .handler(async ({ data }): Promise<{ url: string | null }> => {
    const { signedOcrScanUrl } = await import("@/server/storage");
    return { url: await signedOcrScanUrl(data.scan_key) };
  });

/** 把 OcrError 收成 ok:false；其他例外照丟（那是真的壞了，不是辨識失敗）。 */
async function guard<T>(run: () => Promise<T>): Promise<OcrResult<T>> {
  const { OcrError } = await import("@/server/gemini");
  try {
    return { ok: true, data: await run() };
  } catch (err) {
    if (err instanceof OcrError) {
      return { ok: false, kind: err.kind, message: err.message };
    }
    throw err;
  }
}

export const recognisePurchaseOrder = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(ocrRecogniseSchema)
  .handler(async ({ data }) => {
    const { recognisePurchaseOrder } = await import("@/server/gemini");
    const { listPosProducts } = await import("@/server/repos/inv-sales");

    // 已知商品清單當比對提示。來源把全部 993 筆塞進 prompt；這裡截 300 筆 ——
    // 太長的 prompt 會稀釋注意力，也會讓每一次辨識變貴。
    const products = await listPosProducts();
    const knownProducts = products.slice(0, 300).map((p) => ({
      name: p.name,
      issue_number: p.issue_number,
      series: p.series,
    }));

    return await guard(() => recognisePurchaseOrder({ scanKey: data.scan_key, knownProducts }));
  });

export const recogniseBook = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(ocrRecogniseSchema)
  .handler(async ({ data }) => {
    const { recogniseBook } = await import("@/server/gemini");
    return await guard(() => recogniseBook({ scanKey: data.scan_key }));
  });
