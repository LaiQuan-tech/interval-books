/**
 * Data layer for public.pages + public.page_blocks + public.page_list_items —
 * used exclusively by admin server functions.
 *
 * Every Supabase error is thrown, never swallowed — see src/server/repos/news.ts
 * for the full rationale (a back office silently returning null/empty on a DB
 * error is indistinguishable from "there is no data"). Rows are returned
 * exactly as Supabase returns them — snake_case columns, no camelCase renaming.
 *
 * All three tables live in one file, mirroring src/server/repos/curated.ts:
 * page_blocks and page_list_items both carry page_slug as a required FK
 * (supabase/migrations/0001_init.sql:387-430) and never make sense outside the
 * context of a page.
 *
 * The three tables get three different write shapes on purpose, matching what
 * each one actually is (see supabase/migrations/0001_init.sql:349-430):
 *  - pages (11 seed rows, one per route file): UPDATE only. Never insert or
 *    delete — the route list is fixed in code, not admin-editable, and
 *    pages_deny_insert/pages_deny_delete enforce that at the DB level for
 *    every role except service_role anyway (0001_init.sql:700-707).
 *  - page_blocks (47 seed rows): these are slots consumed by hard-coded
 *    component code (block_key), not records. UPDATE `value` only — never
 *    insert or delete a key.
 *  - page_list_items (24 seed rows): genuinely-repeatable list entries. Full
 *    CRUD, with re-ordering going through the admin_reorder_page_list_items
 *    RPC (see reorderPageListItems below) for the same UNIQUE-constraint
 *    collision reason documented in src/server/repos/curated.ts#reorderCuratedItems.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

/* ------------------------------------------------------------------ *
 * pages
 * ------------------------------------------------------------------ */

const PAGE_COLUMNS =
  "slug, meta_title, meta_description, og_title, og_description, og_image_key, eyebrow_prefix, eyebrow_suffix, header_title, header_intro, sort_order, created_at, updated_at";

export type PageRow = {
  slug: string;
  meta_title: Localized;
  meta_description: Localized;
  og_title: Localized | null;
  og_description: Localized | null;
  og_image_key: string | null;
  eyebrow_prefix: string | null;
  eyebrow_suffix: Localized | null;
  header_title: Localized | null;
  header_intro: Localized | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by updatePageMeta. No id-less "create" path — see file header. */
export type PageMetaUpdateInput = {
  slug: string;
  meta_title: Localized;
  meta_description: Localized;
  og_title?: Localized | null;
  og_description?: Localized | null;
  og_image_key?: string | null;
  eyebrow_prefix?: string | null;
  eyebrow_suffix?: Localized | null;
  header_title?: Localized | null;
  header_intro?: Localized | null;
};

export async function listPages(): Promise<PageRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("pages")
    .select(PAGE_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("slug", { ascending: true });

  if (error) throw new Error(`[repo/pages] listPages 失敗：${error.message}`);
  return (data ?? []) as PageRow[];
}

export async function getPageBySlug(slug: string): Promise<PageRow | null> {
  const { data, error } = await supabaseAdmin().from("pages").select(PAGE_COLUMNS).eq("slug", slug).maybeSingle();

  if (error) throw new Error(`[repo/pages] getPageBySlug 失敗：${error.message}`);
  return (data as PageRow | null) ?? null;
}

/**
 * Updates the editable columns of one existing pages row. Never inserts or
 * deletes (see file header) — `sort_order` is deliberately excluded from the
 * SET clause too: it is not part of pageMetaSchema (src/lib/admin/schemas.ts)
 * and this function never writes it, so the route nav order stays exactly
 * what the original seed data assigned.
 *
 * `.single()` after `.update()` throws if `slug` does not match an existing
 * row (PostgREST returns zero rows -> a "single" error) instead of silently
 * no-op'ing, which doubles as a guard against this ever behaving like a
 * 12th-page insert.
 */
export async function updatePageMeta(input: PageMetaUpdateInput): Promise<PageRow> {
  const { data, error } = await supabaseAdmin()
    .from("pages")
    .update({
      meta_title: input.meta_title,
      meta_description: input.meta_description,
      og_title: input.og_title ?? null,
      og_description: input.og_description ?? null,
      og_image_key: input.og_image_key ?? null,
      eyebrow_prefix: input.eyebrow_prefix && input.eyebrow_prefix.trim() ? input.eyebrow_prefix.trim() : null,
      eyebrow_suffix: input.eyebrow_suffix ?? null,
      header_title: input.header_title ?? null,
      header_intro: input.header_intro ?? null,
    })
    .eq("slug", input.slug)
    .select(PAGE_COLUMNS)
    .single();

  if (error) throw new Error(`[repo/pages] updatePageMeta 失敗：${error.message}`);
  return data as PageRow;
}

/* ------------------------------------------------------------------ *
 * page_blocks
 * ------------------------------------------------------------------ */

const BLOCK_COLUMNS = "id, page_slug, block_key, value, sort_order, created_at, updated_at";

export type PageBlockRow = {
  id: number;
  page_slug: string;
  block_key: string;
  value: Localized;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export async function listPageBlocks(pageSlug: string): Promise<PageBlockRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("page_blocks")
    .select(BLOCK_COLUMNS)
    .eq("page_slug", pageSlug)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/pages] listPageBlocks 失敗：${error.message}`);
  return (data ?? []) as PageBlockRow[];
}

/**
 * Bulk-updates `value` on existing page_blocks rows for one page — the only
 * write path this file exposes for page_blocks. Each row is updated by `id`
 * alone (same minimal-filter convention as
 * src/server/repos/curated.ts#upsertCuratedItem's update branch), and the SET
 * clause only ever assigns `value`: `block_key` and `sort_order` never appear
 * in it, so there is no code path here that could rename, add, or remove a
 * slot — see file header for why that invariant matters (block_key is
 * hard-coded into component code).
 */
export async function bulkUpdatePageBlocks(
  pageSlug: string,
  blocks: { id: number; block_key: string; value: Localized }[],
): Promise<PageBlockRow[]> {
  await Promise.all(
    blocks.map(async (block) => {
      const { error } = await supabaseAdmin().from("page_blocks").update({ value: block.value }).eq("id", block.id);

      if (error) throw new Error(`[repo/pages] bulkUpdatePageBlocks 失敗（${block.block_key}）：${error.message}`);
    }),
  );

  return listPageBlocks(pageSlug);
}

/* ------------------------------------------------------------------ *
 * page_list_items
 * ------------------------------------------------------------------ */

const LIST_ITEM_COLUMNS = "id, page_slug, list_key, label, note, image_key, sort_order, created_at, updated_at";

export type PageListItemRow = {
  id: number;
  page_slug: string;
  list_key: string;
  label: Localized;
  note: Localized | null;
  image_key: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertPageListItem. `id` omitted means "create". */
export type PageListItemUpsertInput = {
  id?: number;
  page_slug: string;
  list_key: string;
  label: Localized;
  note?: Localized | null;
  image_key?: string | null;
  sort_order: number;
};

export async function listPageListItems(pageSlug: string): Promise<PageListItemRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("page_list_items")
    .select(LIST_ITEM_COLUMNS)
    .eq("page_slug", pageSlug)
    .order("list_key", { ascending: true })
    .order("sort_order", { ascending: true });

  if (error) throw new Error(`[repo/pages] listPageListItems 失敗：${error.message}`);
  return (data ?? []) as PageListItemRow[];
}

/**
 * Creates or updates a list item. Unlike page_blocks, page_list_items rows
 * are genuinely addable/removable (see file header) — id is `bigint
 * generated always as identity` (supabase/migrations/0001_init.sql:411-425,
 * same shape as curated_items), so creation omits id and lets the identity
 * sequence assign it — same branch structure as
 * src/server/repos/curated.ts#upsertCuratedItem.
 *
 * `sort_order` is only ever written on the insert branch (appended past the
 * current max for page_slug+list_key — see route: nextSortOrder). The update
 * branch never touches it: page_list_items has
 * UNIQUE(page_slug, list_key, sort_order), and re-ordering existing rows goes
 * exclusively through reorderPageListItems/admin_reorder_page_list_items
 * below — never a per-row UPDATE sort_order here.
 */
export async function upsertPageListItem(input: PageListItemUpsertInput): Promise<PageListItemRow> {
  if (input.id != null) {
    const { data, error } = await supabaseAdmin()
      .from("page_list_items")
      .update({
        list_key: input.list_key,
        label: input.label,
        note: input.note ?? null,
        image_key: input.image_key ?? null,
      })
      .eq("id", input.id)
      .select(LIST_ITEM_COLUMNS)
      .single();

    if (error) throw new Error(`[repo/pages] updatePageListItem 失敗：${error.message}`);
    return data as PageListItemRow;
  }

  const { data, error } = await supabaseAdmin()
    .from("page_list_items")
    .insert({
      page_slug: input.page_slug,
      list_key: input.list_key,
      label: input.label,
      note: input.note ?? null,
      image_key: input.image_key ?? null,
      sort_order: input.sort_order,
    })
    .select(LIST_ITEM_COLUMNS)
    .single();

  if (error) throw new Error(`[repo/pages] insertPageListItem 失敗：${error.message}`);
  return data as PageListItemRow;
}

export async function removePageListItem(id: number): Promise<void> {
  const { error } = await supabaseAdmin().from("page_list_items").delete().eq("id", id);
  if (error) throw new Error(`[repo/pages] removePageListItem 失敗：${error.message}`);
}

/**
 * Reorders items within one page_slug + list_key group via the
 * admin_reorder_page_list_items RPC — NEVER a per-row UPDATE sort_order. See
 * src/server/repos/curated.ts#reorderCuratedItems for the full rationale
 * (page_list_items has UNIQUE(page_slug, list_key, sort_order) —
 * 0001_init.sql:424 — so swapping rows one UPDATE at a time collides with it
 * mid-flight); the SQL function itself lives at
 * supabase/migrations/0002_admin.sql:127-151 and parks rows at negative
 * sort_order before writing final positions, all inside one transaction.
 *
 * `ids` is the full list of item ids for this page_slug+list_key in the
 * desired display order; array position becomes the new sort_order (1-based).
 */
export async function reorderPageListItems(pageSlug: string, listKey: string, ids: number[]): Promise<void> {
  const { error } = await supabaseAdmin().rpc("admin_reorder_page_list_items", {
    p_page_slug: pageSlug,
    p_list_key: listKey,
    p_ids: ids,
  });

  if (error) throw new Error(`[repo/pages] reorderPageListItems 失敗：${error.message}`);
}
