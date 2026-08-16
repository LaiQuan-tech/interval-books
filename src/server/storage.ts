/**
 * Supabase Storage: upload/delete for admin-managed site images.
 *
 * Bucket: site-images (public read, zero storage policies — see the
 * Management API setup that provisioned it). Because there are no INSERT/
 * UPDATE/DELETE policies, anon and authenticated keys cannot write no matter
 * what; only the service role (this module, via supabaseAdmin()) can. That is
 * the entire security model, so this module trusts nothing the caller sends
 * except the raw bytes:
 *   - `file.type` is attacker-controlled (trivially spoofed) and never used
 *     to decide the stored content-type — we sniff magic bytes instead.
 *   - the client's filename is never used for anything; the storage object
 *     name is always a fresh crypto.randomUUID(), so there is no path-
 *     traversal or filename-collision surface.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "./supabase-admin";
import { supabaseUrl } from "./env";

/**
 * Must match the bucket created via the Supabase Management API (public read,
 * no policies) and the `storage:` key prefix resolved by src/lib/images.ts.
 */
export const SITE_IMAGES_BUCKET = "site-images";

/** Mirrors the bucket's own file_size_limit (set at creation time) so we can reject early with a friendly message instead of surfacing the storage API's error. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** image_key values that live in Storage are tagged with this prefix (see src/lib/images.ts). */
const STORAGE_KEY_PREFIX = "storage:";

/** Thrown for any client-controllable reason an upload is rejected. Message is safe to show the admin as-is. */
export class ImageUploadError extends Error {}

type SniffedImage = { extension: string; contentType: string };

/**
 * Identifies the real image format from its bytes. This is the actual
 * security boundary for "what can end up in the bucket" — file.type and the
 * filename extension are both caller-supplied and are never trusted.
 */
function sniffImageFormat(bytes: Uint8Array): SniffedImage | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { extension: "png", contentType: "image/png" };
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }

  // WEBP: "RIFF" .... "WEBP" (RIFF container, WEBP form type at byte 8)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { extension: "webp", contentType: "image/webp" };
  }

  return null;
}

export type UploadedImage = {
  /** Value to store in image_key / og_image_key columns. */
  key: string;
  /** Public URL — the same one src/lib/images.ts#imageFor() would derive from `key`. */
  url: string;
};

/**
 * Validates and uploads one image to the site-images bucket.
 * Throws ImageUploadError for any reason attributable to the input (too
 * large, unrecognized format); throws a plain Error for storage-side failures.
 */
export async function uploadSiteImage(file: File): Promise<UploadedImage> {
  if (file.size <= 0) {
    throw new ImageUploadError("檔案是空的");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new ImageUploadError(`檔案大小 ${mb}MB 超過上限 2MB`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImageFormat(bytes);
  if (!sniffed) {
    throw new ImageUploadError("無法辨識的圖片格式，僅接受 JPEG、PNG 或 WebP");
  }

  const objectName = `${crypto.randomUUID()}.${sniffed.extension}`;

  const { error } = await supabaseAdmin()
    .storage.from(SITE_IMAGES_BUCKET)
    .upload(objectName, bytes, {
      contentType: sniffed.contentType,
      cacheControl: "31536000",
      upsert: false,
    });

  if (error) {
    throw new Error(`圖片上傳失敗：${error.message}`);
  }

  return { key: `${STORAGE_KEY_PREFIX}${objectName}`, url: publicUrlForObject(objectName) };
}

/** Builds the same public URL shape src/lib/images.ts#imageFor() derives for `storage:` keys. */
function publicUrlForObject(objectName: string): string {
  return `${supabaseUrl()}/storage/v1/object/public/${SITE_IMAGES_BUCKET}/${objectName}`;
}

// ---------------------------------------------------------------------------
// OCR 掃描圖 —— 私有 bucket
// ---------------------------------------------------------------------------
/**
 * 0018 建的 `ocr-scans`。與 site-images 的差別只有一個字，但那個字是重點：
 * `public = false`。
 *
 * 進貨單上有廠商名稱、單價與聯絡方式；0009 §0 為了 inv.vendors 的身分證字號把
 * 整個 inv schema 移出 PostgREST，把同一批資訊拍成照片丟進公開 bucket 等於從
 * 後門送出去。所以這裡沒有 publicUrlForObject 的對應物 —— 要看圖只能拿一張有
 * 期限的 signed URL。
 */
export const OCR_SCANS_BUCKET = "ocr-scans";

/** 鏡射 0018 建 bucket 時設的 file_size_limit。進貨單比書封密，所以比 site-images 寬。 */
const MAX_OCR_UPLOAD_BYTES = 4 * 1024 * 1024;

/** signed URL 的有效期。夠一個店員看完一張單子，不夠拿去外面散佈。 */
const OCR_SIGNED_URL_SECONDS = 60 * 30;

/** OCR 掃描圖的 key 前綴。與 image_key 的 `storage:` 刻意不同 —— 那個是公開圖，這個不是，混用會把私有圖餵給 <img src>。 */
const OCR_KEY_PREFIX = "ocr:";

/**
 * 上傳一張要送去辨識的圖，回一個 storage key。
 *
 * ⚠️ **server fn 不收 base64。** 前端壓縮完直接上傳到這裡拿 key，辨識那一支只
 *    收 key。理由兩條：Vercel 的 request body 大約 4.5MB 就滿了，而 base64 會把
 *    圖脹大 33%；還有辨識結果可疑時要調得出原圖來對照（「AI 說單價 50，單子上
 *    到底寫什麼」）。
 */
export async function uploadOcrScan(file: File): Promise<{ key: string }> {
  if (file.size <= 0) {
    throw new ImageUploadError("檔案是空的");
  }
  if (file.size > MAX_OCR_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new ImageUploadError(`檔案大小 ${mb}MB 超過上限 4MB`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // 與 site-images 同一條規矩：file.type 是呼叫端說了算的，只看 magic bytes。
  const sniffed = sniffImageFormat(bytes);
  if (!sniffed) {
    throw new ImageUploadError("無法辨識的圖片格式，僅接受 JPEG、PNG 或 WebP");
  }

  // 依日期分資料夾，之後要清舊圖時好下手（bucket 是私有的，列表只有 service_role 看得到）。
  const day = new Date().toISOString().slice(0, 10);
  const objectName = `${day}/${crypto.randomUUID()}.${sniffed.extension}`;

  const { error } = await supabaseAdmin().storage.from(OCR_SCANS_BUCKET).upload(objectName, bytes, {
    contentType: sniffed.contentType,
    cacheControl: "3600",
    upsert: false,
  });

  if (error) {
    throw new Error(`掃描圖上傳失敗：${error.message}`);
  }

  return { key: `${OCR_KEY_PREFIX}${objectName}` };
}

/** `ocr:2026-08-16/uuid.webp` → `2026-08-16/uuid.webp`。不是 OCR key 就回 null。 */
export function ocrObjectName(key: string): string | null {
  if (!key.startsWith(OCR_KEY_PREFIX)) return null;
  const name = key.slice(OCR_KEY_PREFIX.length);
  // 路徑穿越防線。物件名是這個模組自己產的，但這支是給「呼叫端送 key 進來」用的，
  // 所以還是自己驗一次形狀，而不是相信上游。
  if (!/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(webp|jpg|png)$/.test(name)) return null;
  return name;
}

/** 把私有 bucket 裡的圖讀成 bytes，餵給辨識用。 */
export async function readOcrScan(
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const objectName = ocrObjectName(key);
  if (!objectName) throw new ImageUploadError("掃描圖代碼不正確");

  const { data, error } = await supabaseAdmin().storage.from(OCR_SCANS_BUCKET).download(objectName);
  if (error || !data) {
    throw new Error(`讀取掃描圖失敗：${error?.message ?? "找不到這張圖"}`);
  }

  const bytes = new Uint8Array(await data.arrayBuffer());
  const sniffed = sniffImageFormat(bytes);
  if (!sniffed) throw new Error("掃描圖格式無法辨識");
  return { bytes, contentType: sniffed.contentType };
}

/** 給店員回看原圖用的短期網址。bucket 是私有的，所以沒有永久網址這種東西。 */
export async function signedOcrScanUrl(key: string): Promise<string | null> {
  const objectName = ocrObjectName(key);
  if (!objectName) return null;

  const { data, error } = await supabaseAdmin()
    .storage.from(OCR_SCANS_BUCKET)
    .createSignedUrl(objectName, OCR_SIGNED_URL_SECONDS);

  if (error || !data) return null;
  return data.signedUrl;
}

/**
 * Deletes a previously uploaded image. A no-op for keys that are not
 * storage-managed (bundled asset keys, empty/null) so callers can pass
 * whatever image_key they have without branching on its origin first.
 *
 * Not currently called from any server function — kept here so the module is
 * a complete "upload/delete" library ready for a future replace-image or
 * media-cleanup flow, per the task spec for this file.
 */
export async function deleteSiteImage(key: string | null | undefined): Promise<void> {
  if (!key || !key.startsWith(STORAGE_KEY_PREFIX)) return;
  const objectName = key.slice(STORAGE_KEY_PREFIX.length);
  if (!objectName) return;

  const { error } = await supabaseAdmin().storage.from(SITE_IMAGES_BUCKET).remove([objectName]);
  if (error) {
    throw new Error(`刪除圖片失敗：${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 廠商附件 —— 私有 bucket
// ---------------------------------------------------------------------------
/**
 * 0019 §9.1 的 `vendor-attachments`。與 ocr-scans 同一種東西，但更敏感：合約掃描
 * 檔上會有身分證影本、匯款帳戶、以及雙方簽章。
 *
 * 所以這裡**沒有** publicUrlForObject 的對應物。要看檔案只有一張有期限的
 * signed URL，而且期限比 OCR 還短（見 VENDOR_ATTACHMENT_SIGNED_URL_SECONDS）。
 *
 * ⚠️ 來源系統的 storage policy 是 `bucket_id = 'vendor-attachments' AND
 *    is_approved()` —— 任何一個通過註冊審核的店員都讀得到所有廠商的合約掃描檔，
 *    而且路徑第一段雖然是 vendor_id，policy 完全沒有拿它做 scoping。那套 policy
 *    一條都沒有搬：這個 bucket 一樣是零 storage.objects policy，只有 service_role
 *    進得去，而「這個人能不能看這一家的附件」由 server fn 決定。
 */
export const VENDOR_ATTACHMENTS_BUCKET = "vendor-attachments";

/** 鏡射 0019 §9.1 建 bucket 時設的 file_size_limit（合約可能是多頁掃描 PDF）。 */
const MAX_VENDOR_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * signed URL 的有效期。比 OCR 的 30 分鐘短很多 —— 合約掃描檔的敏感度高一個等級，
 * 而看一份合約不需要 30 分鐘。5 分鐘夠開起來讀，不夠貼到群組裡讓別人也點得開。
 */
const VENDOR_ATTACHMENT_SIGNED_URL_SECONDS = 5 * 60;

/** 廠商附件的 key 前綴。與 `storage:`（公開圖）、`ocr:` 刻意都不同 —— 混用會把私有檔餵給 <img src>。 */
const VENDOR_ATTACHMENT_KEY_PREFIX = "vendorfile:";

/** 合約是 PDF，身分證影本通常是照片。與 bucket 的 allowed_mime_types 對齊。 */
type SniffedAttachment = { extension: string; contentType: string };

function sniffAttachmentFormat(bytes: Uint8Array): SniffedAttachment | null {
  // PDF: 25 50 44 46 ("%PDF")
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return { extension: "pdf", contentType: "application/pdf" };
  }
  const image = sniffImageFormat(bytes);
  return image ? { extension: image.extension, contentType: image.contentType } : null;
}

/**
 * 上傳一份廠商附件，回一個 storage key。
 *
 * ⚠️ 與 site-images / ocr-scans 同一條規矩：`file.type` 是呼叫端說了算的，只看
 *    magic bytes；client 送來的檔名一個字元都不會進到物件名（物件名是
 *    crypto.randomUUID()），所以沒有路徑穿越也沒有檔名碰撞。原始檔名存在
 *    inv.vendor_attachments.file_name，那是資料不是路徑。
 *
 * ⚠️ 路徑第一段是 vendorId，讓「這家的檔案」在 bucket 裡是一個資料夾 —— 解約要
 *    整批清掉時才有下手的地方。但**那個資料夾不是授權邊界**（來源系統就是誤以為
 *    它是），授權在 server fn。
 */
export async function uploadVendorAttachment(
  vendorId: string,
  file: File,
): Promise<{ key: string; fileType: string; fileSize: number }> {
  if (!/^[0-9a-f-]{36}$/.test(vendorId)) {
    throw new ImageUploadError("廠商代碼不正確");
  }
  if (file.size <= 0) {
    throw new ImageUploadError("檔案是空的");
  }
  if (file.size > MAX_VENDOR_ATTACHMENT_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new ImageUploadError(`檔案大小 ${mb}MB 超過上限 20MB`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffAttachmentFormat(bytes);
  if (!sniffed) {
    throw new ImageUploadError("無法辨識的檔案格式，僅接受 PDF、JPEG、PNG 或 WebP");
  }

  const objectName = `${vendorId}/${crypto.randomUUID()}.${sniffed.extension}`;

  const { error } = await supabaseAdmin()
    .storage.from(VENDOR_ATTACHMENTS_BUCKET)
    .upload(objectName, bytes, {
      contentType: sniffed.contentType,
      cacheControl: "0", // 私有檔案不快取
      upsert: false,
    });

  if (error) {
    throw new Error(`附件上傳失敗：${error.message}`);
  }

  return {
    key: `${VENDOR_ATTACHMENT_KEY_PREFIX}${objectName}`,
    fileType: sniffed.contentType,
    fileSize: file.size,
  };
}

/**
 * `vendorfile:<uuid>/<uuid>.pdf` → `<uuid>/<uuid>.pdf`。不是廠商附件 key 就回 null。
 *
 * ⚠️ 這裡是路徑穿越的防線。物件名是這個模組自己產的，但這支是給「呼叫端送 key
 *    進來」用的，所以自己驗一次形狀而不是相信上游（與 ocrObjectName 同一條）。
 */
export function vendorAttachmentObjectName(key: string): string | null {
  if (!key.startsWith(VENDOR_ATTACHMENT_KEY_PREFIX)) return null;
  const name = key.slice(VENDOR_ATTACHMENT_KEY_PREFIX.length);
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|webp|jpg|png)$/.test(name)) return null;
  return name;
}

/** 這個 key 是哪一家廠商的。授權判斷要用，所以獨立一支而不是在呼叫端切字串。 */
export function vendorIdFromAttachmentKey(key: string): string | null {
  const name = vendorAttachmentObjectName(key);
  return name ? name.split("/")[0] : null;
}

/**
 * 短效 signed URL。
 *
 * ⚠️ 呼叫端**必須**先確認這個 key 屬於它有權看的廠商。這一支只做形狀檢查，不做
 *    授權 —— 授權在 fns/inv-vendors.ts 與 fns/vendor-portal.ts，那裡才拿得到
 *    session。（形狀檢查擋不住「拿到另一家的合法 key」，那是授權要擋的事。）
 */
export async function signedVendorAttachmentUrl(key: string): Promise<string | null> {
  const objectName = vendorAttachmentObjectName(key);
  if (!objectName) return null;

  const { data, error } = await supabaseAdmin()
    .storage.from(VENDOR_ATTACHMENTS_BUCKET)
    .createSignedUrl(objectName, VENDOR_ATTACHMENT_SIGNED_URL_SECONDS);

  if (error || !data) return null;
  return data.signedUrl;
}

/** 刪掉 storage 上的檔案。DB 那一列由 inv_delete_vendor_child() 刪，順序見呼叫端。 */
export async function deleteVendorAttachment(key: string): Promise<void> {
  const objectName = vendorAttachmentObjectName(key);
  if (!objectName) return;

  const { error } = await supabaseAdmin()
    .storage.from(VENDOR_ATTACHMENTS_BUCKET)
    .remove([objectName]);

  if (error) throw new Error(`刪除附件失敗：${error.message}`);
}

// ---------------------------------------------------------------------------
// ocr-scans 的保留期限（0019 §9.2）
// ---------------------------------------------------------------------------
/**
 * 刪掉超過保留期限的進貨單掃描圖。
 *
 * ── 為什麼用資料夾名字判斷日期，而不是物件的 created_at ──────────────────
 * uploadOcrScan() 把圖放在 `YYYY-MM-DD/uuid.ext`，那個資料夾名字就是上傳日期
 * （當初分資料夾的理由寫在那支函式的註解裡：「之後要清舊圖時好下手」）。用它比用
 * storage 的 created_at 好，因為資料夾層級可以**整批列出再整批刪**，不必為了讀
 * 每一個物件的 metadata 而把整個 bucket 走一遍。
 *
 * ── 保留天數由資料庫決定 ─────────────────────────────────────────────────
 * public.ocr_scan_retention_days()。抽成函式而不是寫死在這裡，是為了讓「保留
 * 多久」這個政策決定有一個查得到的位置（而不是散在一支排程腳本裡的一個常數）。
 */
export async function purgeExpiredOcrScans(options: { dryRun: boolean }): Promise<{
  cutoff: string;
  retentionDays: number;
  folders: string[];
  objectsRemoved: number;
}> {
  const db = supabaseAdmin();

  const { data: days, error: daysError } = await db.rpc("ocr_scan_retention_days");
  if (daysError) throw new Error(`讀取保留天數失敗：${daysError.message}`);
  const retentionDays = Number(days ?? 180);

  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  // 第一層是日期資料夾。limit 1000 遠大於「一天一個資料夾」能累積的數量。
  const { data: folders, error: listError } = await db.storage
    .from(OCR_SCANS_BUCKET)
    .list("", { limit: 1000 });

  if (listError) throw new Error(`列出掃描圖失敗：${listError.message}`);

  // 只認 YYYY-MM-DD 形狀的資料夾。認不出來的一律留著 —— 清理程式在看不懂的東西
  // 面前應該停手，不是猜。
  const expired = (folders ?? [])
    .map((f) => f.name)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff)
    .sort();

  if (options.dryRun) {
    return { cutoff, retentionDays, folders: expired, objectsRemoved: 0 };
  }

  let objectsRemoved = 0;
  for (const folder of expired) {
    const { data: objects, error } = await db.storage
      .from(OCR_SCANS_BUCKET)
      .list(folder, { limit: 1000 });
    if (error) throw new Error(`列出 ${folder} 失敗：${error.message}`);

    const paths = (objects ?? []).map((o) => `${folder}/${o.name}`);
    if (paths.length === 0) continue;

    const { error: removeError } = await db.storage.from(OCR_SCANS_BUCKET).remove(paths);
    if (removeError) throw new Error(`刪除 ${folder} 失敗：${removeError.message}`);
    objectsRemoved += paths.length;
  }

  return { cutoff, retentionDays, folders: expired, objectsRemoved };
}
