/**
 * Shopping cart — zustand + persist(localStorage).
 *
 * Ported from the same team's Realreal storefront
 * (apps/web/src/lib/cart.ts), keeping its two hard-won behaviours:
 *
 *   1. every mutation clamps against the latest known purchase limit, so a
 *      quantity that exceeds stock can never enter the cart in the first
 *      place; and
 *   2. `skipHydration: true` — the store starts empty on both the server and
 *      the first client render, and is only rehydrated from localStorage
 *      inside an effect. Without this, SSR renders an empty cart, the client
 *      immediately renders a full one, and React reports a hydration mismatch.
 *
 * Four deliberate departures from the Realreal original:
 *
 *   - **No toast() inside the store.** Realreal calls sonner from inside the
 *     `set()` updater, which hardcodes Traditional Chinese strings into a state
 *     reducer. This site is zh/en/ja, so the mutations instead return a result
 *     code and the calling component renders the localized toast. This also
 *     keeps the module free of browser-only imports, so importing it during SSR
 *     is harmless.
 *   - **`partialize`** — Realreal persists the whole state and relies on
 *     JSON.stringify dropping the functions. Naming `items` explicitly means a
 *     future derived field cannot accidentally start being written to disk.
 *   - **`version` + `migrate`** — Realreal has neither, so a shape change would
 *     silently merge stale localStorage into the new code. Anything not written
 *     by the current version is discarded rather than trusted.
 *   - **`syncFromCatalogue`** — a cart line is a snapshot taken at add time.
 *     Realreal patches only the price (updatePrice) and leaves stock stale,
 *     which means a limit enforced against a week-old snapshot. Here the cart
 *     route reconciles every line against the live catalogue on load, so
 *     price, copy and the remaining-quantity cap are current, and products that
 *     have since been de-listed or sold out are visibly flagged rather than
 *     silently carried forward.
 *
 * Checkout and payment are explicitly out of scope for this module; nothing
 * here talks to the server, and the cart is browser-local only.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Localized } from "@/i18n/types";
import type { ShopProduct, ShopProductType } from "@/lib/shop";
import { remainingFor } from "@/lib/shop";

/**
 * Why a line can no longer be bought. Kept as a reason rather than a boolean so
 * the UI can tell the shopper which of the two happened — they are not the same
 * news, and "sold out" is the one worth waiting for.
 */
export type CartUnavailableReason = "delisted" | "sold_out";

/**
 * One line in the cart.
 *
 * `title` is kept as the full {zh,en,ja} object rather than a rendered string
 * so that switching language re-renders the cart in the new language. A cart
 * that lives only in localStorage has no server read to fall back on, so
 * whatever is stored here IS the copy.
 */
export type CartLine = {
  productId: string;
  slug: string;
  title: Localized;
  productType: ShopProductType;
  /** TWD, whole dollars. */
  price: number;
  compareAtPrice: number | null;
  qty: number;
  /**
   * Maximum purchasable quantity as of the last catalogue read; null means
   * genuinely unlimited (a product with stock = NULL, i.e. not stock-managed).
   * Unifies `stock` for goods/book and remaining seats for event/journey —
   * see remainingFor() in src/lib/shop.ts.
   */
  limit: number | null;
  imageKey: string | null;
  /**
   * Set by syncFromCatalogue. The line is kept so the shopper is told what
   * happened, but it is excluded from the count and subtotal and its only
   * available action is removal.
   */
  unavailable?: CartUnavailableReason;
};

/**
 * Outcome of a mutation, so the caller can show the right localized message.
 *   added        — the cart changed as asked
 *   capped       — clamped to the limit; nothing more could be added
 *   out_of_stock — nothing was added at all
 */
export type CartResult = "added" | "capped" | "out_of_stock";

export type CartInput = Omit<CartLine, "qty" | "unavailable"> & { qty: number };

type CartStore = {
  items: CartLine[];
  addItem: (line: CartInput) => CartResult;
  setQty: (productId: string, qty: number) => CartResult;
  removeItem: (productId: string) => void;
  clear: () => void;
  syncFromCatalogue: (products: ShopProduct[]) => void;
};

/** Namespaced like the language key in src/i18n/LanguageContext.tsx. */
const STORAGE_KEY = "interval-books-cart";

/** Bump whenever CartLine changes shape; older payloads are dropped, not merged. */
const STORAGE_VERSION = 1;

function clampToLimit(qty: number, limit: number | null): number {
  if (limit === null) return Math.max(0, qty);
  return Math.max(0, Math.min(qty, limit));
}

export const useCart = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],

      addItem: (line) => {
        const items = get().items;
        const existing = items.find((i) => i.productId === line.productId);
        // Trust the incoming limit over the stored one: it came from the page
        // the shopper is looking at, which is newer than the snapshot.
        const limit = line.limit;

        if (existing) {
          const next = clampToLimit(existing.qty + line.qty, limit);
          if (next <= existing.qty) return next <= 0 ? "out_of_stock" : "capped";
          set({
            items: items.map((i) =>
              i.productId === line.productId
                ? { ...i, ...line, qty: next, unavailable: undefined }
                : i,
            ),
          });
          return "added";
        }

        const next = clampToLimit(line.qty, limit);
        if (next <= 0) return "out_of_stock";
        set({ items: [...items, { ...line, qty: next, unavailable: undefined }] });
        return "added";
      },

      setQty: (productId, qty) => {
        const items = get().items;
        const existing = items.find((i) => i.productId === productId);
        if (!existing) return "out_of_stock";

        // Matching Realreal: decrementing past zero removes the line rather
        // than leaving a 0-quantity row behind.
        if (qty <= 0) {
          set({ items: items.filter((i) => i.productId !== productId) });
          return "added";
        }

        const next = clampToLimit(qty, existing.limit);
        if (next <= 0) {
          set({ items: items.filter((i) => i.productId !== productId) });
          return "out_of_stock";
        }
        if (next !== existing.qty) {
          set({
            items: items.map((i) => (i.productId === productId ? { ...i, qty: next } : i)),
          });
        }
        return next < qty ? "capped" : "added";
      },

      removeItem: (productId) =>
        set((state) => ({ items: state.items.filter((i) => i.productId !== productId) })),

      clear: () => set({ items: [] }),

      /**
       * Refresh every line against the live catalogue.
       *
       * A line whose product has vanished from the active list is flagged
       * `delisted`; one whose remaining quantity has fallen to zero is flagged
       * `sold_out` and its qty is clamped to 0, so the invariant "qty never
       * exceeds limit" holds for every line, not just the ones last touched by
       * a mutation. Neither case deletes the line — the shopper is told.
       *
       * Skips the write entirely when nothing changed, so calling this from an
       * effect cannot loop.
       */
      syncFromCatalogue: (products) => {
        const byId = new Map(products.map((p) => [p.id, p]));
        let changed = false;

        const items = get().items.map((line) => {
          const p = byId.get(line.productId);
          if (!p) {
            if (line.unavailable === "delisted") return line;
            changed = true;
            return { ...line, unavailable: "delisted" as const };
          }

          const limit = remainingFor(p);
          const qty = clampToLimit(line.qty, limit);
          const next: CartLine = {
            ...line,
            slug: p.slug,
            title: p.title,
            productType: p.productType,
            price: p.price,
            compareAtPrice: p.compareAtPrice,
            imageKey: p.imageKey,
            limit,
            qty,
            unavailable: qty <= 0 ? "sold_out" : undefined,
          };

          const same =
            line.slug === next.slug &&
            line.title === next.title &&
            line.productType === next.productType &&
            line.price === next.price &&
            line.compareAtPrice === next.compareAtPrice &&
            line.imageKey === next.imageKey &&
            line.limit === next.limit &&
            line.qty === next.qty &&
            line.unavailable === next.unavailable;
          if (same) return line;
          changed = true;
          return next;
        });

        if (changed) set({ items });
      },
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ items: state.items }),
      migrate: (persisted, version) =>
        version === STORAGE_VERSION ? (persisted as { items: CartLine[] }) : { items: [] },
      // See the file header: nothing is read from localStorage until an effect
      // calls persist.rehydrate(), which is what keeps SSR and the first client
      // render identical.
      skipHydration: true,
    },
  ),
);

/**
 * True once localStorage has been read. Every component that renders cart
 * contents must gate on this and show the empty state until it flips, or the
 * SSR HTML and the first client render will disagree.
 *
 * Realreal repeats this three-line effect in three separate components; it is a
 * hook here so there is one place for it to be right.
 */
export function useCartHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    void useCart.persist.rehydrate();
    setHydrated(true);
  }, []);
  return hydrated;
}

/**
 * Total number of units in the cart, for the header badge.
 *
 * Derived inside the selector rather than exposed as a `total()` method on the
 * store: a method has to be paired with a separate `items` subscription to
 * re-render (a trap the Realreal drawer only avoids by accident), whereas this
 * subscribes to exactly what it reads. It returns a number, so zustand's
 * default reference equality is the correct comparison.
 */
export function useCartCount(): number {
  return useCart((s) => s.items.reduce((sum, i) => (i.unavailable ? sum : sum + i.qty), 0));
}

/** Cart subtotal in whole TWD. Unavailable lines are excluded. */
export function useCartSubtotal(): number {
  return useCart((s) =>
    s.items.reduce((sum, i) => (i.unavailable ? sum : sum + i.price * i.qty), 0),
  );
}

/** Builds a cart line from a catalogue product. Single source of the mapping. */
export function cartInputFor(p: ShopProduct, qty: number): CartInput {
  return {
    productId: p.id,
    slug: p.slug,
    title: p.title,
    productType: p.productType,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    imageKey: p.imageKey,
    limit: remainingFor(p),
    qty,
  };
}
