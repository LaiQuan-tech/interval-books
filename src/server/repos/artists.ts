/**
 * Data layer for public.artists — used exclusively by admin server functions.
 *
 * Same conventions as src/server/repos/exhibitions.ts: every Supabase error is
 * thrown, never swallowed (this is a back office, not the public site —
 * silently returning null/empty on a DB error is indistinguishable from "there
 * is no data"), and rows come back exactly as Supabase returns them —
 * snake_case columns, no camelCase renaming.
 *
 * artists.slug carries its own unique index (supabase/migrations/0019_vendors_pii_portal.sql:2148),
 * separate from the `id` upsert conflict target below, so a duplicate slug
 * raises Postgres 23505 even on an otherwise-normal upsert. upsertArtist()
 * catches that code and rethrows a message naming the offending slug.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ vendor_id 是唯讀的，而且那是一個授權決定，不是一個 UI 決定
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * artists.vendor_id 指到 inv.vendors —— 那張表裡有身分證字號與匯款帳號（0019）。
 * 「這位講者的門面資料長怎樣」與「這家廠商的錢匯到哪裡」是兩個不同的授權面，
 * 讓 CMS 那一頁可以改 vendor_id，等於讓改文案的人重新指定一筆錢的收款對象。
 *
 * 落實方式不是「UI 上不要放那個欄位」（那只是畫面），而是：
 *
 *   · ArtistUpsertInput 這個型別**沒有** vendor_id 這個欄位；
 *   · upsertArtist() 送出的 payload 物件字面值裡**沒有** vendor_id 這個 key。
 *
 * 第二點還順帶保住了既有的綁定：PostgREST 的 upsert 只會對 payload 裡出現過的
 * 欄位產生 `on conflict do update set …`，沒出現的欄位維持原值。所以後台存一次
 * 講者資料，不會把既有的廠商綁定洗成 NULL。
 *
 * ArtistRow **有** vendor_id，因為後台要顯示「已綁定廠商／未綁定」。讀得到、
 * 改不動，這是刻意的不對稱。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ bio / long_bio 是單一語言，不是三語
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 這張表上唯一有第二語言的是 name / name_en，而且那是兩個獨立的 text 欄位，
 * 不是 jsonb。bio、long_bio、discipline 都是純 text —— 它們**不是** Localized，
 * 不可以套 localizedSchema、不可以進 LocalizedField、不可以丟給任何三語 helper。
 * 那種寫法在 TypeScript 上會因為 `string` 與 `{zh,en,ja}` 不相容而擋下來，
 * 但只要中間過一層 any／型別斷言就會安靜地變成畫面上的 "[object Object]"。
 *
 * 要不要把 bio 改成三語 jsonb 是另一期的決定（要一支資料搬遷 migration，
 * 而且人名不該被機器翻譯），不在這一期範圍。
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";

const COLUMNS =
  "id, slug, name, name_en, discipline, bio, long_bio, image_key, portal_url, vendor_id, sort_order, is_active, created_at, updated_at";

/** 掛講者的下拉選單只需要這幾欄，不必把 bio 整包拉進活動後台。 */
const OPTION_COLUMNS = "id, name, name_en, discipline, sort_order, is_active";

export type ArtistRow = {
  id: string;
  slug: string;
  /** 主要顯示名。純字串，不是 Localized —— 見檔頭。 */
  name: string;
  name_en: string | null;
  /** 領域／頭銜，例如「作家」「攝影師」。純字串，不分語言。 */
  discipline: string | null;
  /** 短介紹。純字串，不分語言 —— 見檔頭。 */
  bio: string | null;
  /** 長介紹。純字串，不分語言 —— 見檔頭。 */
  long_bio: string | null;
  /** A bundled asset filename, a "storage:<uuid>.webp" key, or null when unset. */
  image_key: string | null;
  portal_url: string | null;
  /**
   * FK -> inv.vendors(id)，UNIQUE 且可為 NULL。**唯讀** —— 見檔頭。
   * 後台只用它判斷「已綁定廠商／未綁定」，永遠不寫回。
   */
  vendor_id: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** 活動後台那顆「主講人」下拉的選項。 */
export type ArtistOption = {
  id: string;
  name: string;
  name_en: string | null;
  discipline: string | null;
  sort_order: number;
  /** false 的講者不列進下拉，**除非**正在編輯的這一場已經掛著他 —— 見 listArtistOptions()。 */
  is_active: boolean;
};

/**
 * Shape accepted by upsertArtist. `id` omitted (or empty) means "create".
 *
 * ⚠️ **沒有 vendor_id。** 那是會計面的綁定，不是門面資料的一部分 —— 見檔頭。
 */
export type ArtistUpsertInput = {
  id?: string;
  slug: string;
  name: string;
  name_en?: string | null;
  discipline?: string | null;
  bio?: string | null;
  long_bio?: string | null;
  image_key?: string | null;
  portal_url?: string | null;
  sort_order: number;
  is_active: boolean;
};

export async function listArtists(): Promise<ArtistRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("artists")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/artists] list 失敗：${error.message}`);
  return (data ?? []) as ArtistRow[];
}

export async function getArtistById(id: string): Promise<ArtistRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("artists")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/artists] getById 失敗：${error.message}`);
  return (data as ArtistRow | null) ?? null;
}

/**
 * 活動後台「主講人」下拉的選項來源。依 sort_order 排，與前台順序一致。
 *
 * ⚠️ **停用的講者也會回**，而且那是刻意的。
 *
 *    只回 is_active 的話，一位講者被停用之後，去編輯任何一場已經掛著他的舊活動
 *    都會發現下拉裡選不到目前這個值 —— 於是隨手按個儲存就把講者洗成空的。
 *    那是一個「什麼都沒改卻掉資料」的無聲失敗。
 *
 *    正確的分工是：資料層把全部回來，UI 只列 is_active 的**加上目前這一場已經
 *    掛著的那一位**（標示為已停用）。那一段在 src/routes/admin/_shell.events.tsx。
 *
 * 不回 bio / long_bio：下拉只需要名字，沒有理由把整份介紹拉進活動後台的 payload。
 */
export async function listArtistOptions(): Promise<ArtistOption[]> {
  const { data, error } = await supabaseAdmin()
    .from("artists")
    .select(OPTION_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/artists] listOptions 失敗：${error.message}`);
  return (data ?? []) as ArtistOption[];
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. artists.id has no DB default (a plain
 * `text primary key` — supabase/migrations/0019_vendors_pii_portal.sql:2147),
 * so id generation happens here, same as src/server/repos/exhibitions.ts.
 *
 * ⚠️ payload 裡**沒有** vendor_id，理由與後果都在檔頭：PostgREST 只更新 payload
 *    出現過的欄位，所以既有的廠商綁定會原封不動地留著。
 */
export async function upsertArtist(input: ArtistUpsertInput): Promise<ArtistRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();
  const nullable = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

  const { data, error } = await supabaseAdmin()
    .from("artists")
    .upsert(
      {
        id,
        slug: input.slug,
        name: input.name,
        name_en: nullable(input.name_en),
        discipline: nullable(input.discipline),
        bio: nullable(input.bio),
        long_bio: nullable(input.long_bio),
        image_key: nullable(input.image_key),
        portal_url: nullable(input.portal_url),
        sort_order: input.sort_order,
        is_active: input.is_active,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        `[repo/artists] upsert 失敗：網址代稱「${input.slug}」已被使用，請換一個不重複的代稱。`,
      );
    }
    throw new Error(`[repo/artists] upsert 失敗：${error.message}`);
  }
  return data as ArtistRow;
}

/**
 * 刪一位講者。
 *
 * ⚠️ **活動不會跟著被刪。** events.speaker_id 的外鍵是 on delete set null
 *    （supabase/migrations/0025_event_speaker.sql），所以掛在這位講者身上的活動
 *    會留下來，只是變成沒有指定講者。這是刻意的：講者是活動的屬性，不是活動的
 *    所有者，而活動底下還掛著報名紀錄與訂單。
 */
export async function removeArtist(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("artists").delete().eq("id", id);
  if (error) throw new Error(`[repo/artists] remove 失敗：${error.message}`);
}

/**
 * 每位講者目前掛著幾場活動（含未發布 —— set null 不管 is_published）。
 *
 * 用途是刪除前的告知：後台要能說出「這位講者掛在 3 場活動上，刪掉之後那 3 場
 * 會變成沒有講者」，而不是讓人按下去之後才發現前台少了一塊。
 *
 * 與 src/server/repos/events.ts#countEventsByCategory 同一個作法（supabase-js
 * 沒有便宜的 group by，活動總數是幾十筆，拉一欄回來在 JS 數就夠了）。
 */
export async function countEventsBySpeaker(): Promise<Record<string, number>> {
  const { data, error } = await supabaseAdmin().from("events").select("speaker_id");
  if (error) throw new Error(`[repo/artists] countEventsBySpeaker 失敗：${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { speaker_id: string | null }[]) {
    if (!row.speaker_id) continue;
    counts[row.speaker_id] = (counts[row.speaker_id] ?? 0) + 1;
  }
  return counts;
}
