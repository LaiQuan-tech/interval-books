/**
 * Data layer for public.ui_strings — used exclusively by admin server
 * functions. Same throw-on-error contract as src/server/repos/news.ts (see
 * that file for the full rationale on why every Supabase error is thrown
 * rather than swallowed).
 *
 * ui_strings has a composite primary key (group_key, string_key) — see
 * supabase/migrations/0001_init.sql:119-133 — and every row is created once
 * by supabase/seed.sql to mirror src/i18n/strings.ts. group_key/string_key
 * are consumed directly by application code (rebuilt client-side into the UI
 * object shape), so this file intentionally has no insert()/upsert()/
 * delete(): only select() and update(), and every update() is filtered by
 * BOTH key columns and never writes them — it can only ever touch a row that
 * already exists, never create one.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS = "group_key, string_key, value, sort_order, created_at, updated_at";

export type UiStringRow = {
  group_key: string;
  string_key: string;
  value: Localized;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/**
 * Shape accepted by updateUiString. group_key/string_key identify the row
 * (used only in .eq() filters below — never in the SET payload); value and
 * sort_order are the only columns this file ever writes.
 */
export type UiStringUpdateInput = {
  group_key: string;
  string_key: string;
  value: Localized;
  sort_order: number;
};

export async function listUiStrings(): Promise<UiStringRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("ui_strings")
    .select(COLUMNS)
    .order("group_key", { ascending: true })
    .order("sort_order", { ascending: true });

  if (error) throw new Error(`[repo/ui-strings] list 失敗：${error.message}`);
  return (data ?? []) as UiStringRow[];
}

/**
 * Updates one row's value/sort_order. group_key/string_key are used only as
 * the WHERE clause (.eq twice) — never written — so this cannot rename a
 * key, and a group_key/string_key pair that doesn't already exist simply
 * matches zero rows rather than creating one.
 */
export async function updateUiString(input: UiStringUpdateInput): Promise<UiStringRow> {
  const { data, error } = await supabaseAdmin()
    .from("ui_strings")
    .update({ value: input.value, sort_order: input.sort_order })
    .eq("group_key", input.group_key)
    .eq("string_key", input.string_key)
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/ui-strings] update 失敗：${error.message}`);
  return data as UiStringRow;
}

/**
 * Updates many rows in one call — the admin page edits all 33 rows on one
 * page (src/routes/admin/_shell.strings.tsx) and saves them together rather
 * than one round-trip per row. Each row still goes through the same
 * key-filtered UPDATE as updateUiString above (run in parallel); there is no
 * bulk insert/upsert involved.
 */
export async function updateUiStrings(inputs: UiStringUpdateInput[]): Promise<UiStringRow[]> {
  return await Promise.all(inputs.map((input) => updateUiString(input)));
}
