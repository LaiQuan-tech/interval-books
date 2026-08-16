/**
 * 拍照辨識在瀏覽器這一端的兩件事：把圖變成 storage key、把失敗變成看得懂的話。
 *
 * ── 「只送 key，不送圖」是硬規定 ──────────────────────────────────────────
 *     壓縮（image-compress.ts）→ uploadOcrScan(FormData) → "ocr:…"
 *     recognisePurchaseOrder({ scan_key })   ← 送的是這個字串
 *
 * 這個檔案裡**沒有** toDataURL、沒有 base64、沒有任何一個 data: 開頭的字串會流向
 * server fn。來源進銷存是把整張 data URL（手機照 5.4MB）塞進 request body，而
 * Vercel serverless 的 body 大約 4.5MB 就滿了 —— 那條路在這個平台上本來就走不通。
 * 相機拍完的畫面也是走 canvas.toBlob，不是 toDataURL（見 WebcamCapture.tsx）。
 */
import {
  compressImage,
  extensionFor,
  OCR_MAX_EDGE_PX,
  OCR_WEBP_QUALITY,
} from "@/lib/admin/image-compress";
import type { OcrFailureKindValue } from "@/lib/admin/schemas";

/** 辨識失敗的統一形狀。ok:false 與「真的丟出來的例外」都收斂成這個。 */
export type OcrFailure = { kind: OcrFailureKindValue; message: string };

/**
 * 壓縮並上傳一張要辨識的圖，回 storage key。
 *
 * 相機給的是 Blob、選檔給的是 File，compressImage() 收的是 File —— 差別只有一個
 * 檔名，所以這裡補一個。壓縮本身會順手把 EXIF／GPS 洗掉（重畫到 canvas）。
 */
export async function uploadOcrImage(source: File | Blob): Promise<string> {
  const file =
    source instanceof File
      ? source
      : new File([source], "capture.jpg", { type: source.type || "image/jpeg" });

  const compressed = await compressImage(file, {
    maxEdge: OCR_MAX_EDGE_PX,
    quality: OCR_WEBP_QUALITY,
  });

  const formData = new FormData();
  formData.append("file", compressed, `scan.${extensionFor(compressed)}`);

  const { uploadOcrScan } = await import("@/lib/admin/fns/ocr");
  const { key } = await uploadOcrScan({ data: formData });
  return key;
}

/**
 * 例外 → OcrFailure。
 *
 * 網路斷線、session 過期被 middleware 擋下來，這些是**丟出來**的（fns/ocr.ts 的
 * guard 只把 OcrError 收成 ok:false，其他照丟）。它們一樣要落在「還可以手動輸入」
 * 的那個畫面上，不是一個只剩關閉鈕的死路，所以在這裡一起收斂成 service。
 */
export function toOcrFailure(err: unknown): OcrFailure {
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "service", message: message || "辨識失敗，請改用手動輸入。" };
}

export type OcrAdvice = {
  /** 標題。五種 kind 只會對到四種說法（bad_response 與 service 都是服務異常）。 */
  title: string;
  /** 下一步該做什麼。每一種都以「還可以手動輸入」收尾。 */
  hint: string;
  /** 主要動作：wait = 現在重試沒有用；retry = 同一張圖再辨識一次；recapture = 重拍。 */
  action: "wait" | "retry" | "recapture";
};

/**
 * 失敗的種類決定畫面要說什麼。
 *
 * 來源那兩支 edge function 把 429 與 500 都變成同一句「操作失敗，請稍後再試」，
 * 於是額度用完（等一下就好）與服務掛掉（等多久都沒用）在店員眼裡一模一樣。
 */
export function ocrFailureAdvice(kind: OcrFailureKindValue): OcrAdvice {
  switch (kind) {
    case "quota":
      return {
        title: "辨識服務忙碌中，請稍後再試",
        hint: "額度或呼叫頻率到上限了 —— 現在重試也是一樣的結果。等幾分鐘再拍，或直接手動輸入。",
        action: "wait",
      };
    case "timeout":
      return {
        title: "辨識逾時，可以重試",
        hint: "圖已經上傳成功了，不用重拍 —— 按「再辨識一次」就好。不想等的話也可以直接手動輸入。",
        action: "retry",
      };
    case "no_content":
      return {
        title: "這張照片讀不出內容，建議重拍",
        hint: "對焦、光線、拍滿整張單據或整個封面會差很多。重拍一次，或直接手動輸入。",
        action: "recapture",
      };
    case "bad_response":
    case "service":
    default:
      return {
        title: "辨識服務異常",
        hint: "這不是照片的問題。可以再試一次，若持續發生請通知管理員 —— 期間先手動輸入，資料不會因此卡住。",
        action: "retry",
      };
  }
}
