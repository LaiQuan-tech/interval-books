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

/** Shared by every resource that can be hidden from the public site. */
const publishFields = {
  id: z.string().trim().min(1).optional(),
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
};

/**
 * events.registration_type is a CHECK constraint in the DB, so the enum here is
 * not a UI preference — a value outside these two is rejected by Postgres.
 */
const registrationFields = {
  external_url: z.string().trim().url("請輸入完整網址（含 https://）"),
  registration_type: z.enum(["external", "internal"]),
  payment_enabled: z.boolean(),
};

export const eventSchema = z.object({
  ...publishFields,
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  display_date: z.string().trim().min(1, "請輸入顯示用日期文字"),
  // Nullable in the DB and never populated by the original content; kept
  // optional so the form does not invent a date.
  iso_date: z.string().trim().optional().nullable(),
  category: z.string().trim().min(1, "請選擇分類"),
  ...registrationFields,
});
export type EventFormValues = z.infer<typeof eventSchema>;

export const eventCategorySchema = z.object({
  id: z.string().trim().min(1, "請輸入分類代碼"),
  label: localizedSchema,
  sort_order: z.number().int("排序必須是整數"),
});
export type EventCategoryFormValues = z.infer<typeof eventCategorySchema>;

export const exhibitionSchema = z.object({
  ...publishFields,
  slug: z.string().trim().min(1, "請輸入網址代稱"),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  // Plain text, not localized — the source data stores a date range string.
  period: z.string().trim().min(1, "請輸入展期"),
  location: localizedSchema,
  image_key: z.string().trim().optional().nullable(),
});
export type ExhibitionFormValues = z.infer<typeof exhibitionSchema>;

export const journeySchema = z.object({
  ...publishFields,
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  days: localizedSchema,
  theme: localizedSchema,
  ...registrationFields,
});
export type JourneyFormValues = z.infer<typeof journeySchema>;

export const collaborationSchema = z.object({
  ...publishFields,
  title: localizedSchema,
  description: localizedSchema,
});
export type CollaborationFormValues = z.infer<typeof collaborationSchema>;

export const curatedThemeSchema = z.object({
  ...publishFields,
  title: localizedSchema,
  description: localizedSchema,
});
export type CuratedThemeFormValues = z.infer<typeof curatedThemeSchema>;

/** curated_items.id is a bigint identity, so it is a number rather than text. */
export const curatedItemSchema = z.object({
  id: z.number().int().optional(),
  theme_id: z.string().trim().min(1),
  name: localizedSchema,
  note: localizedSchema,
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
});
export type CuratedItemFormValues = z.infer<typeof curatedItemSchema>;

/* ------------------------------------------------------------------ *
 * Phase 3 — page copy and site-wide settings
 * ------------------------------------------------------------------ */

/**
 * A localized field that genuinely may be absent. Only for DB columns that are
 * nullable — when the column is NOT NULL, use `localizedSchema`, because
 * is_localized() rejects partial objects.
 */
const optionalLocalizedSchema = localizedSchema.nullable().optional();

/** `pages` is one row per route. Rows are never created or deleted here. */
export const pageMetaSchema = z.object({
  slug: z.string().trim().min(1),
  meta_title: localizedSchema,
  meta_description: localizedSchema,
  og_title: optionalLocalizedSchema,
  og_description: optionalLocalizedSchema,
  og_image_key: z.string().trim().nullable().optional(),
  eyebrow_prefix: z.string().trim().nullable().optional(),
  eyebrow_suffix: optionalLocalizedSchema,
  header_title: optionalLocalizedSchema,
  header_intro: optionalLocalizedSchema,
});
export type PageMetaFormValues = z.infer<typeof pageMetaSchema>;

/**
 * Block keys are consumed by hard-coded component code, so the admin edits
 * values only — it never adds or removes a key.
 */
export const pageBlockSchema = z.object({
  id: z.number().int(),
  block_key: z.string(),
  value: localizedSchema,
});
export const pageBlocksBulkSchema = z.object({
  page_slug: z.string().trim().min(1),
  blocks: z.array(pageBlockSchema),
});
export type PageBlocksBulkValues = z.infer<typeof pageBlocksBulkSchema>;

/** Unlike blocks, list rows are genuinely addable — a route can gain a stop. */
export const pageListItemSchema = z.object({
  id: z.number().int().optional(),
  page_slug: z.string().trim().min(1),
  list_key: z.string().trim().min(1),
  label: localizedSchema,
  note: optionalLocalizedSchema,
  image_key: z.string().trim().nullable().optional(),
  sort_order: z.number().int(),
});
export type PageListItemFormValues = z.infer<typeof pageListItemSchema>;

/** Single row, `check (id = 1)` — update only, never insert or delete. */
export const siteSettingsSchema = z.object({
  short_desc: localizedSchema,
  address: localizedSchema,
  city: localizedSchema,
  hours: localizedSchema,
  closed: localizedSchema,
  contact_email: z.string().trim().email("請輸入有效的電子郵件"),
  site_url: z.string().trim().url("請輸入完整網址"),
  // Empty string is meaningful: the footer hides links whose value is blank.
  social_instagram: z.string().trim(),
  social_facebook: z.string().trim(),
  social_line: z.string().trim(),
  map_embed: z.string().trim(),
  map_link: z.string().trim(),
  map_apple: z.string().trim(),
  meta_site_name: z.string().trim(),
  meta_author: z.string().trim(),
  meta_twitter_card: z.string().trim(),
  meta_og_type: z.string().trim(),
  default_meta_title: z.string().trim(),
  default_meta_description: z.string().trim(),
});
export type SiteSettingsFormValues = z.infer<typeof siteSettingsSchema>;

/** Composite PK (group_key, string_key) — both identify the row, not editable. */
export const uiStringSchema = z.object({
  group_key: z.string().trim().min(1),
  string_key: z.string().trim().min(1),
  value: localizedSchema,
  sort_order: z.number().int(),
});
export type UiStringFormValues = z.infer<typeof uiStringSchema>;

/** Plain text throughout — these are phone numbers, not prose. */
export const contactPhoneSchema = z.object({
  id: z.number().int().optional(),
  label: z.string().trim().min(1, "請輸入標籤"),
  display_text: z.string().trim().min(1, "請輸入顯示文字"),
  tel: z.string().trim().min(1, "請輸入撥號用號碼"),
  sort_order: z.number().int(),
});
export type ContactPhoneFormValues = z.infer<typeof contactPhoneSchema>;
