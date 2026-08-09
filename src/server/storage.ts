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
