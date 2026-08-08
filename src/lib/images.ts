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

/** Resolves an image_key, falling back to a bundled asset when the key is unknown. */
export function imageFor(key: string | null | undefined, fallback: string): string {
  if (!key) return fallback;
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
