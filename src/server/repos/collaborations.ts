/**
 * Data layer for public.collaborations — used exclusively by admin server
 * functions. Same shape as src/server/repos/news.ts (see that file for the
 * full rationale on throwing every Supabase error rather than swallowing it).
 *
 * Rows are returned exactly as Supabase returns them — snake_case columns,
 * no camelCase renaming.
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS = "id, title, description, is_published, sort_order, created_at, updated_at";

export type CollaborationRow = {
  id: string;
  title: Localized;
  description: Localized;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertCollaboration. `id` omitted (or empty) means "create". */
export type CollaborationUpsertInput = {
  id?: string;
  title: Localized;
  description: Localized;
  is_published: boolean;
  sort_order: number;
};

export async function listCollaborations(): Promise<CollaborationRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("collaborations")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/collaborations] list 失敗：${error.message}`);
  return (data ?? []) as CollaborationRow[];
}

export async function getCollaborationById(id: string): Promise<CollaborationRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("collaborations")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/collaborations] getById 失敗：${error.message}`);
  return (data as CollaborationRow | null) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. collaborations.id has no DB default
 * (plain `text primary key`, not identity — supabase/migrations/0001_init.sql:331-341),
 * so id generation has to happen here rather than being left to Postgres.
 */
export async function upsertCollaboration(input: CollaborationUpsertInput): Promise<CollaborationRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();

  const { data, error } = await supabaseAdmin()
    .from("collaborations")
    .upsert(
      {
        id,
        title: input.title,
        description: input.description,
        is_published: input.is_published,
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/collaborations] upsert 失敗：${error.message}`);
  return data as CollaborationRow;
}

export async function removeCollaboration(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("collaborations").delete().eq("id", id);
  if (error) throw new Error(`[repo/collaborations] remove 失敗：${error.message}`);
}
