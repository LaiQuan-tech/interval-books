/**
 * Data layer for public.news — used exclusively by admin server functions.
 *
 * Every Supabase error is thrown, never swallowed. src/lib/cms.ts degrades to
 * bundled fallback copy on error, which is correct for the public site (never
 * white-screen a visitor over a DB hiccup) but wrong here: a back office that
 * silently returns null/empty on a permission or connection error looks
 * indistinguishable from "there is no data", and an admin could believe a
 * write succeeded when it never reached the database. Callers (the server
 * functions in src/lib/admin/fns/news.ts) run behind adminFnMiddleware, which
 * already turns thrown errors into a rejected server-fn call the UI can show.
 *
 * Rows are returned exactly as Supabase returns them — snake_case columns,
 * no camelCase renaming — so what you see here matches supabase/migrations
 * column-for-column.
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, title, summary, description, display_date, is_published, sort_order, created_at, updated_at";

export type NewsRow = {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  display_date: string;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertNews. `id` omitted (or empty) means "create". */
export type NewsUpsertInput = {
  id?: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  display_date: string;
  is_published: boolean;
  sort_order: number;
};

export async function listNews(): Promise<NewsRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("news")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/news] list 失敗：${error.message}`);
  return (data ?? []) as NewsRow[];
}

export async function getNewsById(id: string): Promise<NewsRow | null> {
  const { data, error } = await supabaseAdmin().from("news").select(COLUMNS).eq("id", id).maybeSingle();

  if (error) throw new Error(`[repo/news] getById 失敗：${error.message}`);
  return (data as NewsRow | null) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. news.id has no DB default (it is a
 * plain `text primary key`, not an identity column — see
 * supabase/migrations/0001_init.sql:270-283), so id generation has to happen
 * here rather than being left to Postgres.
 */
export async function upsertNews(input: NewsUpsertInput): Promise<NewsRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();

  const { data, error } = await supabaseAdmin()
    .from("news")
    .upsert(
      {
        id,
        title: input.title,
        summary: input.summary,
        description: input.description,
        display_date: input.display_date,
        is_published: input.is_published,
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/news] upsert 失敗：${error.message}`);
  return data as NewsRow;
}

export async function removeNews(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("news").delete().eq("id", id);
  if (error) throw new Error(`[repo/news] remove 失敗：${error.message}`);
}
