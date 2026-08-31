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
 * ⚠️ speaker_id 是 supabase/migrations/0025_event_speaker.sql 加的欄位。原本這裡
 *    寫死 select 它，於是「0025 還沒套上 live DB」就等於**整個活動後台打不開**
 *    —— 而那正是實際發生的事（0024 與 0025 都推了程式碼但沒能套上正式庫）。
 *
 *    現在改成下面那個能力偵測：先照有 speaker_id 的欄位清單問，收到
 *    「這一欄不存在」就記住並改用不含它的清單重問一次。後果從「後台死掉」
 *    降級成「後台活著，只是暫時沒有主講人欄位」。
 *
 *    🔴 這是**過渡程式碼**。0025 套上正式庫之後，speakerColumnPresent 會在第一次
 *       查詢就變成 true 並且永遠不再走 fallback（不需要重新部署）。確認正式庫已有
 *       speaker_id 之後，把 COLUMNS_BASE / speakerColumnPresent /
 *       isMissingSpeakerColumn / selectEvents / stripSpeaker 這五樣一起刪掉，
 *       COLUMNS 直接用回原本那一串。scripts/artists-selftest.mjs 有一條斷言
 *       守著這段註解還在。
 *
 *    公開站從頭到尾不受影響：src/lib/cms.ts#fetchEvents() 的欄位清單是它自己
 *    寫死的一串，沒有 speaker_id。
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, title, summary, description, display_date, iso_date, category, speaker_id, external_url, registration_type, payment_enabled, is_published, sort_order, created_at, updated_at";

/** 0025 尚未套用時用的欄位清單。與 COLUMNS 的唯一差別就是少了 speaker_id。 */
const COLUMNS_BASE = COLUMNS.replace(" speaker_id,", "");

/**
 * 這個資料庫有沒有 events.speaker_id。
 *
 * null = 還沒問過（一律先當成「有」去問，所以 migration 一落地就自動恢復）。
 * 刻意不做成「啟動時探測一次」：那會讓每一個 cold start 多一次往返，而這裡
 * 的 fallback 只有在真的缺欄位時才會付出代價。
 */
let speakerColumnPresent: boolean | null = null;

/** PostgREST 對「select 了不存在的欄位」回 42703，對「寫入不存在的欄位」回 PGRST204。 */
function isMissingSpeakerColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code !== "42703" && error.code !== "PGRST204") return false;
  return (error.message ?? "").includes("speaker_id");
}

/**
 * 跑一次查詢；只有在對方明講「speaker_id 這一欄不存在」時，才改用
 * COLUMNS_BASE 重跑一次。其他任何錯誤都原樣往上拋 —— 這支檔案的既有紀律是
 * 「每一個 Supabase 錯誤都要拋，絕不吞掉」，fallback 不可以變成吞錯誤的破口。
 */
async function selectEvents<T>(
  run: (
    cols: string,
  ) => PromiseLike<{ data: T; error: { code?: string; message?: string } | null }>,
): Promise<{ data: T; error: { code?: string; message?: string } | null }> {
  const first = await run(speakerColumnPresent === false ? COLUMNS_BASE : COLUMNS);
  if (isMissingSpeakerColumn(first.error)) {
    speakerColumnPresent = false;
    return await run(COLUMNS_BASE);
  }
  if (!first.error) speakerColumnPresent = true;
  return first;
}

/** 沒有 speaker_id 欄位時，補一個 null 上去，讓 EventRow 的型別對外仍然成立。 */
function stripSpeaker<T extends object>(row: T): T & { speaker_id: string | null } {
  return "speaker_id" in row
    ? (row as T & { speaker_id: string | null })
    : { ...row, speaker_id: null };
}

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
  const { data, error } = await selectEvents((cols) =>
    supabaseAdmin()
      .from("events")
      .select(cols)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true }),
  );

  if (error) throw new Error(`[repo/events] list 失敗：${error.message}`);
  return ((data ?? []) as object[]).map(stripSpeaker) as EventRow[];
}

export async function getEventById(id: string): Promise<EventRow | null> {
  const { data, error } = await selectEvents((cols) =>
    supabaseAdmin().from("events").select(cols).eq("id", id).maybeSingle(),
  );

  if (error) throw new Error(`[repo/events] getById 失敗：${error.message}`);
  return data ? (stripSpeaker(data as object) as EventRow) : null;
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

  // speaker_id 宣告成 optional，整個 payload 才是**一個**型別而不是兩個的聯集。
  // 聯集會讓 supabase-js 的 RejectExcessProperties 拒收（它對聯集的每一支各驗
  // 一次多餘欄位），那正是這裡曾經編不過的原因。
  type EventUpsertRow = Omit<EventUpsertInput, "id" | "iso_date" | "speaker_id"> & {
    id: string;
    iso_date: string | null;
    speaker_id?: string | null;
  };

  const payload: EventUpsertRow = {
    id,
    title: input.title,
    summary: input.summary,
    description: input.description,
    display_date: input.display_date,
    iso_date: isoDate,
    category: input.category,
    external_url: input.external_url,
    registration_type: input.registration_type,
    payment_enabled: input.payment_enabled,
    is_published: input.is_published,
    sort_order: input.sort_order,
  };

  const { data, error } = await selectEvents((cols) => {
    if (cols === COLUMNS_BASE) {
      delete payload.speaker_id;
    } else {
      // 空字串（下拉選了「不指定」）與 undefined 一律寫回 NULL —— 空字串不是
      // 合法的 artists.id，送出去只會吃 23503。
      payload.speaker_id =
        input.speaker_id && input.speaker_id.trim() ? input.speaker_id.trim() : null;
    }
    return supabaseAdmin()
      .from("events")
      .upsert(payload, { onConflict: "id" })
      .select(cols)
      .single();
  });

  if (error) throw new Error(`[repo/events] upsert 失敗：${error.message}`);
  return stripSpeaker(data as object) as EventRow;
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
