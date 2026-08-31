/**
 * Data layer for public.events — used exclusively by admin server functions.
 *
 * Mirrors src/server/repos/news.ts: every Supabase error is thrown, never
 * swallowed. A back office that silently returns null/empty on a permission
 * or connection error looks indistinguishable from "there is no data", and an
 * admin could believe a write succeeded when it never reached the database.
 * Callers (src/lib/admin/fns/events.ts) run behind adminFnMiddleware, which
 * already turns thrown errors into a rejected server-fn call the UI can show.
 *
 * Rows are returned exactly as Supabase returns them — snake_case columns,
 * no camelCase renaming — so what you see here matches
 * supabase/migrations/0001_init.sql:172-205 column-for-column.
 *
 * ⚠️ 部署順序：下面的 COLUMNS 會 select speaker_id，而那一欄是
 *    supabase/migrations/0025_event_speaker.sql 加的。**0025 必須先套上 live DB，
 *    才能推這支程式碼** —— 欄位還不存在時 PostgREST 直接回錯誤，而這支是
 *    /admin/events 的 loader，也就是整個活動後台打不開。
 *
 *    公開站不受影響：src/lib/cms.ts#fetchEvents() 的欄位清單是它自己寫死的一串，
 *    沒有 speaker_id。
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, title, summary, description, display_date, iso_date, category, speaker_id, external_url, registration_type, payment_enabled, is_published, sort_order, created_at, updated_at";

export type EventRegistrationType = "external" | "internal";

export type EventRow = {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  display_date: string;
  /** Nullable in the DB and never populated by the original content (see
   * supabase/migrations/0001_init.sql:198) — phase-2 sorting field. */
  iso_date: string | null;
  /** FK -> event_categories.id, `on delete restrict` (see
   * supabase/migrations/0001_init.sql:182-183). */
  category: string;
  /**
   * 主講人。FK -> public.artists(id)，`on delete set null`（見
   * supabase/migrations/0025_event_speaker.sql）。NULL 代表這場沒有指定講者。
   *
   * ⚠️ 刪掉一位講者**不會**刪掉活動 —— 那個外鍵刻意不是 cascade。活動底下還掛著
   *    報名紀錄（0020）與訂單（0005），cascade 會把它們一起帶走。
   */
  speaker_id: string | null;
  external_url: string;
  registration_type: EventRegistrationType;
  payment_enabled: boolean;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertEvent. `id` omitted (or empty) means "create". */
export type EventUpsertInput = {
  id?: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  display_date: string;
  iso_date?: string | null;
  category: string;
  speaker_id?: string | null;
  external_url: string;
  registration_type: EventRegistrationType;
  payment_enabled: boolean;
  is_published: boolean;
  sort_order: number;
};

export async function listEvents(): Promise<EventRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("events")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/events] list 失敗：${error.message}`);
  return (data ?? []) as EventRow[];
}

export async function getEventById(id: string): Promise<EventRow | null> {
  const { data, error } = await supabaseAdmin().from("events").select(COLUMNS).eq("id", id).maybeSingle();

  if (error) throw new Error(`[repo/events] getById 失敗：${error.message}`);
  return (data as EventRow | null) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. events.id has no DB default (it is a
 * plain `text primary key`, not an identity column — see
 * supabase/migrations/0001_init.sql:175-176, same shape as news.id), so id
 * generation has to happen here rather than being left to Postgres.
 */
export async function upsertEvent(input: EventUpsertInput): Promise<EventRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();
  const isoDate = input.iso_date && input.iso_date.trim() ? input.iso_date.trim() : null;

  const { data, error } = await supabaseAdmin()
    .from("events")
    .upsert(
      {
        id,
        title: input.title,
        summary: input.summary,
        description: input.description,
        display_date: input.display_date,
        iso_date: isoDate,
        category: input.category,
        // 空字串（下拉選了「不指定」）與 undefined 一律寫回 NULL —— 空字串不是
        // 合法的 artists.id，送出去只會吃 23503。
        speaker_id: input.speaker_id && input.speaker_id.trim() ? input.speaker_id.trim() : null,
        external_url: input.external_url,
        registration_type: input.registration_type,
        payment_enabled: input.payment_enabled,
        is_published: input.is_published,
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/events] upsert 失敗：${error.message}`);
  return data as EventRow;
}

export async function removeEvent(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("events").delete().eq("id", id);
  if (error) throw new Error(`[repo/events] remove 失敗：${error.message}`);
}

/**
 * Returns how many events currently reference each category id (all events,
 * published or not — the DB's `on delete restrict` FK does not care about
 * is_published). Used by the event-categories admin page to disable "刪除"
 * up front on any category still in use, instead of letting an admin hit a
 * raw Postgres 23503 foreign-key-violation error after the fact.
 *
 * There is no cheap PostgREST "group by" query via supabase-js, and with a
 * handful of events total, fetching just the `category` column and counting
 * in JS is simpler and fast enough than adding an RPC function.
 */
export async function countEventsByCategory(): Promise<Record<string, number>> {
  const { data, error } = await supabaseAdmin().from("events").select("category");
  if (error) throw new Error(`[repo/events] countEventsByCategory 失敗：${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { category: string }[]) {
    counts[row.category] = (counts[row.category] ?? 0) + 1;
  }
  return counts;
}
