/**
 * Data layer for public.event_categories — used exclusively by admin server
 * functions. See src/server/repos/news.ts for the throw-never-swallow
 * rationale; the same applies here.
 *
 * Unlike news/events, event_categories.id is a natural key: it is the
 * Chinese literal that events.category also stores (e.g. "讀書會" — see
 * supabase/migrations/0001_init.sql:156-158 and the seed data at
 * supabase/seed.sql:95-98), not a generated UUID. upsertEventCategory
 * therefore never invents an id — the caller must always supply one.
 *
 * This table has no is_published column (see
 * supabase/migrations/0001_init.sql:159-166) — categories are not
 * individually hideable from the public site.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS = "id, label, sort_order, created_at, updated_at";

export type EventCategoryRow = {
  id: string;
  label: Localized;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type EventCategoryUpsertInput = {
  id: string;
  label: Localized;
  sort_order: number;
};

export async function listEventCategories(): Promise<EventCategoryRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("event_categories")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/event-categories] list 失敗：${error.message}`);
  return (data ?? []) as EventCategoryRow[];
}

export async function getEventCategoryById(id: string): Promise<EventCategoryRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("event_categories")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/event-categories] getById 失敗：${error.message}`);
  return (data as EventCategoryRow | null) ?? null;
}

export async function upsertEventCategory(
  input: EventCategoryUpsertInput,
): Promise<EventCategoryRow> {
  const { data, error } = await supabaseAdmin()
    .from("event_categories")
    .upsert(
      {
        id: input.id,
        label: input.label,
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/event-categories] upsert 失敗：${error.message}`);
  return data as EventCategoryRow;
}

/**
 * events.category references event_categories(id) with `on delete restrict`
 * (supabase/migrations/0001_init.sql:182-183). The categories admin page
 * checks usage counts up front (src/server/repos/events.ts
 * countEventsByCategory) and disables "刪除" while a category is still in
 * use, but this catch is a defense-in-depth backstop against a race — e.g.
 * an event gets (re)assigned to this category in another tab between this
 * page's load and the delete click — turning a raw Postgres 23503 into a
 * message an admin can actually act on instead of an opaque DB error.
 */
export async function removeEventCategory(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("event_categories").delete().eq("id", id);
  if (error) {
    if (error.code === "23503") {
      throw new Error(
        "[repo/event-categories] remove 失敗：此分類仍有活動使用中，請先將相關活動改為其他分類後再刪除。",
      );
    }
    throw new Error(`[repo/event-categories] remove 失敗：${error.message}`);
  }
}
