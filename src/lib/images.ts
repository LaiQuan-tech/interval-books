import bookstoreInterior from "@/assets/bookstore-interior.jpg";
import curatedObjects from "@/assets/curated-objects.jpg";
import eventReading from "@/assets/event-reading.jpg";
import exhibitionCorner from "@/assets/exhibition-corner.jpg";
import heroMountain from "@/assets/hero-mountain.jpg";
import journeyMist from "@/assets/journey-mist.jpg";
import storefront from "@/assets/storefront.jpg";

/**
 * image_key -> bundled asset URL.
 *
 * Images are NOT stored in the database. Vite content-hashes every asset at
 * build time, so a path saved in Postgres would break on the next deploy. The
 * DB stores only the filename key (exhibitions.image_key, pages.og_image_key,
 * page_list_items.image_key) and this map resolves it to the real import.
 *
 * Admin-uploaded images are a second, parallel source living in the Supabase
 * Storage `site-images` bucket rather than in this bundle — see the
 * `storage:` branch of imageFor() below. The two are expected to coexist
 * indefinitely: these 7 bundled images stay put and keep being used as the
 * `fallback` argument at every call site (the last resort when the DB itself
 * is unreachable), so they are never migrated into Storage.
 */
export const IMAGE_BY_KEY: Record<string, string> = {
  "bookstore-interior.jpg": bookstoreInterior,
  "curated-objects.jpg": curatedObjects,
  "event-reading.jpg": eventReading,
  "exhibition-corner.jpg": exhibitionCorner,
  "hero-mountain.jpg": heroMountain,
  "journey-mist.jpg": journeyMist,
  "storefront.jpg": storefront,
};

/**
 * image_key values pointing into Storage (rather than this bundle) carry this
 * prefix, e.g. "storage:3f1c9c1e-....webp". Must match the prefix
 * src/server/storage.ts#uploadSiteImage() stamps onto every key it returns.
 */
const STORAGE_KEY_PREFIX = "storage:";

/**
 * The Storage project URL. Deliberately read via import.meta.env rather than
 * src/server/env.ts#supabaseUrl(): that module is server-only (see its doc
 * comment) and this file is not — imageFor() runs in route loaders (server)
 * and again in the same components during client-side render/hydration, so it
 * needs a value Vite has inlined into BOTH bundles. VITE_SUPABASE_URL is
 * exactly that, and (like the anon key) is public information already shipped
 * to the browser via src/lib/supabase.ts.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;

/** Must match the bucket name the images were uploaded into (src/server/storage.ts#SITE_IMAGES_BUCKET). */
const STORAGE_BUCKET = "site-images";

function storagePublicUrl(objectName: string): string | null {
  if (!SUPABASE_URL || !objectName) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${objectName}`;
}

/**
 * Resolves an image_key to a displayable URL:
 *   1. `storage:<name>` -> the Storage object's public URL
 *   2. a known bundled key -> its Vite asset URL
 *   3. anything else (null, unknown key, misconfigured Storage URL) -> fallback
 */
export function imageFor(key: string | null | undefined, fallback: string): string {
  if (!key) return fallback;
  if (key.startsWith(STORAGE_KEY_PREFIX)) {
    return storagePublicUrl(key.slice(STORAGE_KEY_PREFIX.length)) ?? fallback;
  }
  return IMAGE_BY_KEY[key] ?? fallback;
}

export {
  bookstoreInterior,
  curatedObjects,
  eventReading,
  exhibitionCorner,
  heroMountain,
  journeyMist,
  storefront,
};
