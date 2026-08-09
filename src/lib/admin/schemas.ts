/**
 * Zod schemas for the admin back office.
 *
 * localizedSchema mirrors the DB's is_localized() CHECK constraint (see
 * supabase/migrations/0001_init.sql:56-68): zh/en/ja must all be present and
 * non-empty. Validating this client-side means the 23514 constraint violation
 * never happens in practice — the form blocks submission with a field-level
 * message instead of a raw Postgres error code.
 */
import { z } from "zod";

export const localizedSchema = z.object({
  zh: z.string().trim().min(1, "請輸入中文內容"),
  en: z.string().trim().min(1, "請輸入英文內容"),
  ja: z.string().trim().min(1, "請輸入日文內容"),
});

export type LocalizedInput = z.infer<typeof localizedSchema>;

/**
 * Covers both create and update: `id` absent/empty means "create a new row"
 * (src/server/repos/news.ts generates one). Present means "update that row".
 */
export const newsSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  display_date: z.string().trim().min(1, "請輸入顯示用日期文字，例如 2026.05.22–05.24"),
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
});

export type NewsFormValues = z.infer<typeof newsSchema>;
