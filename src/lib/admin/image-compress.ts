/**
 * 瀏覽器端的圖片壓縮，ImageField 與拍照辨識共用。
 *
 * 這一段本來只長在 src/components/admin/ImageField.tsx 裡。4c 接 OCR 時抽出來，
 * 因為兩邊要的是**同一件事**而不是像的事：兩條路最後都會把 bytes 送進一個
 * Vercel serverless function，而那裡的 request body 大約 4.5MB 就滿了。
 * 一張手機直出的照片自己就能撐爆（來源進銷存的 OCR 就是直接送 5.4MB 的 data URL）。
 *
 * pipeline：
 *   createImageBitmap(file, { imageOrientation: "from-image" })  // 依 EXIF 轉正
 *     -> canvas，長邊上限 maxEdge
 *     -> canvas.toBlob("image/webp", quality)
 *
 * 重畫到 canvas 會順手把所有 metadata（EXIF、GPS…）洗掉 —— 不需要再做別的。
 *
 * ⚠️ 這裡的檢查**不是安全邊界**。伺服器端（src/server/storage.ts）會自己嗅
 *    magic bytes、自己擋大小，不看任何前端送來的宣告。
 */

/** 型錄／商品照。與 ImageField 原本的常數逐字相同。 */
export const IMAGE_MAX_EDGE_PX = 2000;
export const IMAGE_WEBP_QUALITY = 0.82;

/**
 * 辨識用的掃描圖。
 *
 * 比商品照小一點：辨識吃的是文字清晰度不是解析度，1600px 對書封與 A4 進貨單都
 * 夠讀，而每一次辨識都要把 bytes 轉 base64 送進 Gemini —— 小一點就是快一點、
 * 便宜一點。品質拉高到 0.9，因為壓縮瑕疵會直接變成讀錯的字。
 */
export const OCR_MAX_EDGE_PX = 1600;
export const OCR_WEBP_QUALITY = 0.9;

export type CompressOptions = {
  maxEdge: number;
  quality: number;
};

/**
 * 縮圖並重新編碼。全程在瀏覽器，不碰網路。
 *
 * @throws 瀏覽器不支援 canvas、或編不出任何一種格式時
 */
export async function compressImage(file: File, options: CompressOptions): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    // Math.min(1, …)：只縮不放。本來就比上限小的圖不要被放大成一團糊。
    const scale = Math.min(1, options.maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("此瀏覽器不支援圖片處理");
    ctx.drawImage(bitmap, 0, 0, width, height);

    const webp = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", options.quality),
    );
    if (webp) return webp;

    // 罕見：編得出 canvas 但編不出 webp 的瀏覽器。jpeg 是通用退路，伺服器也收。
    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", options.quality),
    );
    if (jpeg) return jpeg;

    throw new Error("圖片壓縮失敗，請換一張圖片再試");
  } finally {
    bitmap.close();
  }
}

/** 壓縮後的 blob 要用什麼副檔名。伺服器不看它（只嗅 magic bytes），但檔名要合理。 */
export function extensionFor(blob: Blob): "jpg" | "webp" {
  return blob.type === "image/jpeg" ? "jpg" : "webp";
}
