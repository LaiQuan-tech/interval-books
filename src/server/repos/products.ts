/**
 * Data layer for public.products — used exclusively by admin server
 * functions. Same conventions as src/server/repos/news.ts: every Supabase
 * error is thrown, never swallowed (this is a back office, not the public
 * site — silently returning null/empty on a DB error would be
 * indistinguishable from "there is no data", and an admin could believe a
 * write succeeded when it never reached the database). Rows are returned
 * exactly as Supabase returns them — snake_case columns, no camelCase
 * renaming — so what you see here matches
 * supabase/migrations/0004_commerce_products.sql column-for-column.
 *
 * products.slug carries its own unique index, separate from the `id` upsert
 * conflict target below, so a duplicate slug still raises Postgres error
 * 23505 even on an otherwise-normal upsert. upsertProduct() catches that
 * specific code and rethrows a message naming the offending slug, same
 * pattern as src/server/repos/exhibitions.ts#upsertExhibition.
 *
 * seats_taken is deliberately absent from ProductUpsertInput and never
 * appears in the upsert() write payload below. It is maintained exclusively
 * by the reserve_product_seat() RPC (see
 * supabase/migrations/0004_commerce_products.sql) as bookings come in through
 * checkout; a form write here would race that RPC and could silently
 * under/overcount seats. It is still selected in COLUMNS so the admin
 * list/edit views can show it read-only (e.g. "已報名 3 / 20").
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, slug, product_type, source_type, source_id, title, summary, description, price, compare_at_price, stock, capacity, seats_taken, image_key, requires_shipping, status, sort_order, created_at, updated_at";

export type ProductType = "goods" | "book" | "event" | "journey";
export type ProductSourceType = "event" | "journey" | "curated_item";
export type ProductStatus = "draft" | "active" | "archived";

export type ProductRow = {
  id: string;
  slug: string;
  product_type: ProductType;
  /** Optional link back to the CMS row this product is sold from — not a FK. */
  source_type: ProductSourceType | null;
  source_id: string | null;
  title: Localized;
  summary: Localized;
  description: Localized;
  /** TWD, whole dollars — never cents (see migration comment). */
  price: number;
  compare_at_price: number | null;
  /** NULL = not stock-managed. Only ever changed via atomic_deduct_stock(). */
  stock: number | null;
  /** Bookings only (event/journey). NULL for goods/book. */
  capacity: number | null;
  /** Read-only. Maintained exclusively by reserve_product_seat() — never write this. */
  seats_taken: number;
  image_key: string | null;
  requires_shipping: boolean;
  status: ProductStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/**
 * Shape accepted by upsertProduct. `id` omitted (or empty) means "create".
 * `seats_taken` is intentionally not part of this type — see file header.
 */
export type ProductUpsertInput = {
  id?: string;
  slug: string;
  product_type: ProductType;
  source_type?: ProductSourceType | null;
  source_id?: string | null;
  title: Localized;
  summary: Localized;
  description: Localized;
  price: number;
  compare_at_price?: number | null;
  stock?: number | null;
  capacity?: number | null;
  image_key?: string | null;
  requires_shipping: boolean;
  status: ProductStatus;
  sort_order: number;
};

export async function listProducts(): Promise<ProductRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("products")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/products] list 失敗：${error.message}`);
  return (data ?? []) as ProductRow[];
}

export async function getProductById(id: string): Promise<ProductRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("products")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/products] getById 失敗：${error.message}`);
  return (data as ProductRow | null) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. products.id has no DB default (it is
 * a plain `text primary key`, not an identity column — see
 * supabase/migrations/0004_commerce_products.sql:32-33, same shape as
 * news.id), so id generation has to happen here rather than being left to
 * Postgres.
 *
 * The write payload deliberately omits seats_taken — see file header — so a
 * concurrent reserve_product_seat() call can never be clobbered by an admin
 * saving this form.
 */
export async function upsertProduct(input: ProductUpsertInput): Promise<ProductRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();

  const { data, error } = await supabaseAdmin()
    .from("products")
    .upsert(
      {
        id,
        slug: input.slug,
        product_type: input.product_type,
        source_type: input.source_type ?? null,
        source_id: input.source_id ?? null,
        title: input.title,
        summary: input.summary,
        description: input.description,
        price: input.price,
        compare_at_price: input.compare_at_price ?? null,
        stock: input.stock ?? null,
        capacity: input.capacity ?? null,
        image_key: input.image_key ?? null,
        requires_shipping: input.requires_shipping,
        status: input.status,
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        `[repo/products] upsert 失敗：網址代稱「${input.slug}」已被使用，請換一個不重複的代稱。`,
      );
    }
    if (error.code === "23514") {
      // Defence in depth: the form's zod schema (productSchema, in
      // src/lib/admin/schemas.ts) already blocks the most common way to hit
      // this — event/journey without a capacity — before the request is
      // ever sent. This branch only fires for a case that schema cannot see,
      // e.g. lowering capacity below an existing seats_taken on an update.
      throw new Error(
        `[repo/products] upsert 失敗：欄位組合不符合資料庫限制（例如名額低於目前已報名人數）。${error.message}`,
      );
    }
    throw new Error(`[repo/products] upsert 失敗：${error.message}`);
  }
  return data as ProductRow;
}

export async function removeProduct(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("products").delete().eq("id", id);
  if (error) throw new Error(`[repo/products] remove 失敗：${error.message}`);
}
