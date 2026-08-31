/**
 * Data layer for public.exhibitions — used exclusively by admin server
 * functions. Same conventions as src/server/repos/news.ts: every Supabase
 * error is thrown, never swallowed (this is a back office, not the public
 * site — silently returning null/empty on a DB error would be indistinguishable
 * from "there is no data"), and rows are returned exactly as Supabase returns
 * them — snake_case columns, no camelCase renaming.
 *
 * exhibitions.slug carries its own unique index (supabase/migrations/0001_init.sql:213),
 * separate from the `id` upsert conflict target below, so a duplicate slug
 * still raises Postgres error 23505 even on an otherwise-normal upsert.
 * upsertExhibition() catches that specific code and rethrows a message naming
 * the offending slug, so the admin UI shows something actionable instead of
 * a raw "duplicate key value violates unique constraint" string.
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, slug, title, summary, description, period, location, image_key, is_published, sort_order, created_at, updated_at";

export type ExhibitionRow = {
  id: string;
  slug: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  /** Plain display text, e.g. "2025.04.20 – 2025.06.15" — NOT localized, unlike most other text columns on this table. */
  period: string;
  location: Localized;
  /** A bundled asset filename (e.g. "exhibition-corner.jpg"), a "storage:<uuid>.webp" key, or null when unset. */
  image_key: string | null;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertExhibition. `id` omitted (or empty) means "create". */
export type ExhibitionUpsertInput = {
  id?: string;
  slug: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  period: string;
  location: Localized;
  image_key?: string | null;
  is_published: boolean;
  sort_order: number;
};

export async function listExhibitions(): Promise<ExhibitionRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("exhibitions")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/exhibitions] list 失敗：${error.message}`);
  return (data ?? []) as ExhibitionRow[];
}

export async function getExhibitionById(id: string): Promise<ExhibitionRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("exhibitions")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/exhibitions] getById 失敗：${error.message}`);
  return (data as ExhibitionRow | null) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. exhibitions.id has no DB default (a
 * plain `text primary key`, not an identity column — see
 * supabase/migrations/0001_init.sql:211-228), so id generation happens here,
 * same as src/server/repos/news.ts#upsertNews.
 */
export async function upsertExhibition(input: ExhibitionUpsertInput): Promise<ExhibitionRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();

  const { data, error } = await supabaseAdmin()
    .from("exhibitions")
    .upsert(
      {
        id,
        slug: input.slug,
        title: input.title,
        summary: input.summary,
        description: input.description,
        period: input.period,
        location: input.location,
        image_key: input.image_key ?? null,
        is_published: input.is_published,
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        `[repo/exhibitions] upsert 失敗：網址代稱「${input.slug}」已被使用，請換一個不重複的代稱。`,
      );
    }
    throw new Error(`[repo/exhibitions] upsert 失敗：${error.message}`);
  }
  return data as ExhibitionRow;
}

export async function removeExhibition(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("exhibitions").delete().eq("id", id);
  if (error) throw new Error(`[repo/exhibitions] remove 失敗：${error.message}`);
}
