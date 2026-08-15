/**
 * Public storefront read layer for public.products.
 *
 * WHY THIS USES THE ANON CLIENT RATHER THAN src/server/repos/products.ts
 * ---------------------------------------------------------------------
 * There were two existing patterns to choose from and they are not
 * interchangeable:
 *
 *   - src/server/repos/*.ts run on supabaseAdmin() (service_role). service_role
 *     **bypasses RLS entirely**. Reaching for it here would mean the only thing
 *     standing between the storefront and every draft/archived product is a
 *     `.eq("status", "active")` that a future refactor can drop without any
 *     test noticing. Those repos are also `import "@tanstack/react-start/server-only"`
 *     and belong to the back office.
 *
 *   - src/lib/cms.ts runs on the anon client from src/lib/supabase.ts. The anon
 *     key can only ever see what RLS lets it see, and
 *     supabase/migrations/0004_commerce_products.sql already encodes exactly the
 *     rule this file needs:
 *         create policy products_select_public ... using (status = 'active')
 *     so non-active rows are unreachable at the database level, not merely
 *     unselected here. The same migration revokes every write, and
 *     0005_commerce_orders.sql gives anon *no* grants at all on
 *     orders/payments/etc — so this client is structurally incapable of leaking
 *     order data even if someone later asks it to.
 *
 * This file therefore follows the cms.ts pattern. The `.eq("status", "active")`
 * below is defence in depth on top of the policy, not the primary control.
 *
 * Note also that no createServerFn is involved: like every other public read in
 * this app, these run from TanStack Router loaders, which execute on the server
 * during SSR (so crawlers get real HTML) and in the browser on client-side
 * navigation (so no extra round-trip). That is the established convention here
 * — see src/routes/curated.tsx.
 *
 * ONE DELIBERATE DEPARTURE FROM cms.ts
 * ------------------------------------
 * cms.ts swallows every error and substitutes bundled copy, because site copy
 * has a sensible in-repo fallback. Products do not: there is no bundled
 * catalogue, so "the query failed" and "nothing is for sale" would collapse
 * into the same empty list and the shop would quietly look closed during a DB
 * hiccup. These functions therefore still never throw, but they report the
 * distinction via `unavailable` so the UI can say "temporarily unavailable"
 * instead of "no products".
 */
import { supabase } from "@/lib/supabase";
import type { Localized } from "@/i18n/types";

/** Mirrors the product_type CHECK in 0004_commerce_products.sql. */
export type ShopProductType = "goods" | "book" | "event" | "journey";

export const SHOP_PRODUCT_TYPES: ShopProductType[] = ["goods", "book", "event", "journey"];

/**
 * A single sellable item, camelCased for the components (the admin repo keeps
 * snake_case on purpose; the public site has always used camelCase — see the
 * cms.ts header).
 *
 * `status` is intentionally absent: every row that reaches this type is active
 * by construction, so there is no value a component could usefully branch on
 * and no way for a non-active row to be mistaken for a sellable one.
 */
export type ShopProduct = {
  id: string;
  slug: string;
  productType: ShopProductType;
  title: Localized;
  summary: Localized;
  description: Localized;
  /** TWD, whole dollars — never cents (see the 0004 migration comment). */
  price: number;
  /** Struck-through "was" price when present. */
  compareAtPrice: number | null;
  /** goods/book only. NULL = not stock-managed, i.e. always purchasable. */
  stock: number | null;
  /** event/journey only. NOT NULL for those types per products_capacity_shape. */
  capacity: number | null;
  seatsTaken: number;
  imageKey: string | null;
  requiresShipping: boolean;
  sortOrder: number;
  /**
   * How many of this product can actually be bought right now, read from
   * public.product_availability (migration 0011) and **capped at 10**.
   *
   * This is the only number the storefront gets for a product whose stock lives
   * in the shop's inventory system: those rows have products.stock = NULL by
   * construction, so `stock` above cannot answer the question. The cap is
   * deliberate — exact stock is commercial information, and "10" here means
   * "10 or more", which is all a shopper needs.
   *
   * null when the availability read failed or was not attempted; callers must
   * fall back to `stock` rather than treating null as "sold out".
   */
  availableCapped: number | null;
};

export type ShopListResult = {
  products: ShopProduct[];
  /**
   * True only when the read itself failed (network down, Supabase not
   * configured, permission error). An empty `products` with `unavailable:false`
   * genuinely means "nothing is on sale".
   */
  unavailable: boolean;
};

export type ShopProductResult = {
  product: ShopProduct | null;
  unavailable: boolean;
};

/**
 * Every column the storefront needs — and nothing else. Deliberately does not
 * include `status` (see ShopProduct) or `source_type`/`source_id`, which are a
 * CMS bookkeeping detail the shop has no use for.
 */
const COLUMNS =
  "id, slug, product_type, title, summary, description, price, compare_at_price, stock, capacity, seats_taken, image_key, requires_shipping, sort_order";

// -----------------------------------------------------------------------------
// Row mapping
// -----------------------------------------------------------------------------

type Row = Record<string, unknown>;

function isLocalized(v: unknown): v is Localized {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.zh === "string" && typeof o.en === "string" && typeof o.ja === "string";
}

function loc(v: unknown): Localized | null {
  return isLocalized(v) ? { zh: v.zh, en: v.en, ja: v.ja } : null;
}

function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function nullableInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function isProductType(v: unknown): v is ShopProductType {
  return typeof v === "string" && (SHOP_PRODUCT_TYPES as string[]).includes(v);
}

/**
 * Returns null for any row that cannot be trusted — a missing slug or a jsonb
 * column that is not {zh,en,ja} would otherwise render as `undefined` in the
 * page. Same defensive posture as cms.ts, which skips malformed rows rather
 * than crashing the route.
 */
function toProduct(r: Row): ShopProduct | null {
  const id = typeof r.id === "string" ? r.id : null;
  const slug = typeof r.slug === "string" ? r.slug : null;
  const title = loc(r.title);
  const summary = loc(r.summary);
  const description = loc(r.description);
  if (!id || !slug || !title || !summary || !description) return null;
  if (!isProductType(r.product_type)) return null;

  return {
    id,
    slug,
    productType: r.product_type,
    title,
    summary,
    description,
    price: int(r.price, 0),
    compareAtPrice: nullableInt(r.compare_at_price),
    stock: nullableInt(r.stock),
    capacity: nullableInt(r.capacity),
    seatsTaken: int(r.seats_taken, 0),
    imageKey: nullableStr(r.image_key),
    requiresShipping: r.requires_shipping !== false,
    sortOrder: int(r.sort_order, 0),
    availableCapped: null,
  };
}

function logFailure(what: string, message: string) {
  console.warn(`[shop] ${what} unavailable — ${message}`);
}

/**
 * Reads public.product_availability for the given ids and writes the answer
 * onto the products in place.
 *
 * Best effort on purpose. A failure here leaves `availableCapped` at null and
 * remainingFor() falls back to products.stock — which for an inventory-backed
 * product means "not stock-managed", i.e. the shop stays open rather than
 * showing everything as sold out because one extra read blinked. The real
 * guard is reserve_inventory_stock() at checkout; this is display only.
 *
 * The view is readable by anon and exposes exactly three columns. It has no
 * path to inv.products — anon does not even hold USAGE on that schema.
 */
async function attachAvailability(products: ShopProduct[]): Promise<void> {
  const db = supabase;
  if (!db || products.length === 0) return;
  try {
    const { data, error } = await db
      .from("product_availability")
      .select("product_id, available_capped")
      .in(
        "product_id",
        products.map((p) => p.id),
      );
    if (error || !Array.isArray(data)) {
      logFailure("availability", error?.message ?? "unexpected response shape");
      return;
    }
    const byId = new Map<string, number>();
    for (const row of data as unknown as Row[]) {
      const id = typeof row.product_id === "string" ? row.product_id : null;
      const cap = nullableInt(row.available_capped);
      if (id !== null && cap !== null) byId.set(id, cap);
    }
    for (const p of products) {
      const cap = byId.get(p.id);
      if (cap !== undefined) p.availableCapped = cap;
    }
  } catch (err) {
    logFailure("availability", err instanceof Error ? err.message : String(err));
  }
}

// -----------------------------------------------------------------------------
// Availability
// -----------------------------------------------------------------------------

/**
 * How many units may still be added, or null when the product is not
 * quantity-limited at all.
 *
 * event/journey are limited by remaining seats; `capacity` is NOT NULL for those
 * types (products_capacity_shape in 0004), so the null branch there only fires
 * on malformed data and errs towards "no limit known" rather than blocking a
 * sale.
 *
 * goods/book have two sources and the order between them is load-bearing:
 *
 *   `stock` wins when it is set. Those products are managed entirely by
 *   public.products and atomic_deduct_stock(), exactly as before 0011 — reading
 *   the capped view for them would silently turn a stock of 40 into "10 left".
 *
 *   `availableCapped` is used only when `stock` is NULL. That covers products
 *   sold out of the shop's real inventory (0011 forces their catalog stock to
 *   NULL so the two numbers can never disagree) and products that are not
 *   stock-managed at all, for which the view reports the cap — i.e. "plenty",
 *   which is the same thing the old `null` return meant to a shopper.
 */
export function remainingFor(p: ShopProduct): number | null {
  if (p.productType === "event" || p.productType === "journey") {
    if (p.capacity === null) return null;
    return Math.max(0, p.capacity - p.seatsTaken);
  }
  if (p.stock !== null) return p.stock;
  return p.availableCapped;
}

/** True when nothing more can be added. `remaining === null` is never sold out. */
export function isSoldOut(p: ShopProduct): boolean {
  const remaining = remainingFor(p);
  return remaining !== null && remaining <= 0;
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/**
 * All purchasable products, in the order the back office arranged them
 * (`sort_order`, then `id` so ties are stable across page loads rather than
 * left to PostgREST).
 */
export async function fetchActiveProducts(): Promise<ShopListResult> {
  const db = supabase;
  if (!db) {
    logFailure("products", "Supabase is not configured");
    return { products: [], unavailable: true };
  }
  try {
    const { data, error } = await db
      .from("products")
      .select(COLUMNS)
      .eq("status", "active")
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (error || !Array.isArray(data)) {
      logFailure("products", error?.message ?? "unexpected response shape");
      return { products: [], unavailable: true };
    }

    const products: ShopProduct[] = [];
    for (const row of data as unknown as Row[]) {
      const p = toProduct(row);
      if (p) products.push(p);
    }
    await attachAvailability(products);
    return { products, unavailable: false };
  } catch (err) {
    logFailure("products", err instanceof Error ? err.message : String(err));
    return { products: [], unavailable: true };
  }
}

/**
 * One product by its public slug. `product: null` with `unavailable: false`
 * means the slug really does not exist (or is not active) and the caller should
 * render a 404; `unavailable: true` means we could not tell.
 */
export async function fetchActiveProductBySlug(slug: string): Promise<ShopProductResult> {
  const db = supabase;
  if (!db) {
    logFailure(`products/${slug}`, "Supabase is not configured");
    return { product: null, unavailable: true };
  }
  try {
    const { data, error } = await db
      .from("products")
      .select(COLUMNS)
      .eq("status", "active")
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      logFailure(`products/${slug}`, error.message);
      return { product: null, unavailable: true };
    }
    if (!data) return { product: null, unavailable: false };
    const product = toProduct(data as unknown as Row);
    if (product) await attachAvailability([product]);
    return { product, unavailable: false };
  } catch (err) {
    logFailure(`products/${slug}`, err instanceof Error ? err.message : String(err));
    return { product: null, unavailable: true };
  }
}

/** NT$1,280 — the site shows whole dollars everywhere. */
export function formatPrice(twd: number): string {
  return `NT$${twd.toLocaleString("en-US")}`;
}
