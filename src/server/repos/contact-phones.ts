/**
 * Data layer for public.contact_phones — used exclusively by admin server
 * functions. Same throw-on-error contract as src/server/repos/news.ts (see
 * that file for the full rationale on why every Supabase error is thrown
 * rather than swallowed).
 *
 * Unlike news/collaborations/curated_themes (plain `text primary key`),
 * contact_phones.id is `bigint primary key generated always as identity`
 * (supabase/migrations/0001_init.sql:139-147) — the same column shape as
 * curated_items.id. Postgres rejects an explicit id on INSERT into an
 * identity column (without OVERRIDING SYSTEM VALUE), so creation cannot go
 * through a single upsert() the way the text-PK tables do; it must branch on
 * whether `id` was supplied, exactly like upsertCuratedItem in
 * src/server/repos/curated.ts. Unlike curated_items, there is no
 * unique(sort_order) constraint on this table, so sort_order is a plain
 * column here — no reorder RPC needed, it is written directly in both
 * branches below.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

const COLUMNS = "id, label, display_text, tel, sort_order, created_at, updated_at";

export type ContactPhoneRow = {
  id: number;
  label: string;
  display_text: string;
  tel: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertContactPhone. `id` omitted (or null) means "create". */
export type ContactPhoneUpsertInput = {
  id?: number;
  label: string;
  display_text: string;
  tel: string;
  sort_order: number;
};

export async function listContactPhones(): Promise<ContactPhoneRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("contact_phones")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/contact-phones] list 失敗：${error.message}`);
  return (data ?? []) as ContactPhoneRow[];
}

export async function getContactPhoneById(id: number): Promise<ContactPhoneRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("contact_phones")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/contact-phones] getById 失敗：${error.message}`);
  return (data as ContactPhoneRow | null) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row and let the identity column assign it. See the file
 * banner for why this must branch rather than call upsert() once.
 */
export async function upsertContactPhone(input: ContactPhoneUpsertInput): Promise<ContactPhoneRow> {
  if (input.id != null) {
    const { data, error } = await supabaseAdmin()
      .from("contact_phones")
      .update({
        label: input.label,
        display_text: input.display_text,
        tel: input.tel,
        sort_order: input.sort_order,
      })
      .eq("id", input.id)
      .select(COLUMNS)
      .single();

    if (error) throw new Error(`[repo/contact-phones] update 失敗：${error.message}`);
    return data as ContactPhoneRow;
  }

  const { data, error } = await supabaseAdmin()
    .from("contact_phones")
    .insert({
      label: input.label,
      display_text: input.display_text,
      tel: input.tel,
      sort_order: input.sort_order,
    })
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/contact-phones] insert 失敗：${error.message}`);
  return data as ContactPhoneRow;
}

export async function removeContactPhone(id: number): Promise<void> {
  const { error } = await supabaseAdmin().from("contact_phones").delete().eq("id", id);
  if (error) throw new Error(`[repo/contact-phones] remove 失敗：${error.message}`);
}
