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
  };
}

function logFailure(what: string, message: string) {
  console.warn(`[shop] ${what} unavailable — ${message}`);
}

// -----------------------------------------------------------------------------
// Availability
// -----------------------------------------------------------------------------

/**
 * How many units may still be added, or null when the product is not
 * quantity-limited at all.
 *
 * goods/book are limited by `stock`, where NULL means "not stock-managed" and
 * so is genuinely unlimited. event/journey are limited by remaining seats;
 * `capacity` is NOT NULL for those types (products_capacity_shape in 0004), so
 * the null branch there only fires on malformed data and errs towards "no
 * limit known" rather than blocking a sale.
 */
export function remainingFor(p: ShopProduct): number | null {
  if (p.productType === "event" || p.productType === "journey") {
    if (p.capacity === null) return null;
    return Math.max(0, p.capacity - p.seatsTaken);
  }
  return p.stock;
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
    return { product: toProduct(data as unknown as Row), unavailable: false };
  } catch (err) {
    logFailure(`products/${slug}`, err instanceof Error ? err.message : String(err));
    return { product: null, unavailable: true };
  }
}

/** NT$1,280 — the site shows whole dollars everywhere. */
export function formatPrice(twd: number): string {
  return `NT$${twd.toLocaleString("en-US")}`;
}
