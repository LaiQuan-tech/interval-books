/**
 * Data layer for public.site_settings — used exclusively by admin server
 * functions. Same throw-on-error contract as src/server/repos/news.ts (see
 * that file for the full rationale on why every Supabase error is thrown
 * rather than swallowed).
 *
 * site_settings is a singleton: exactly one row exists, with
 * `id smallint primary key generated always as identity` constrained to
 * `check (id = 1)` (supabase/migrations/0001_init.sql:78-107). The row is
 * created once by supabase/seed.sql and is NEVER created or deleted from the
 * app — this file intentionally has no insert()/upsert()/delete() call, only
 * select() and update(), and both are hard-pinned to id = 1 (never taken
 * from caller input), so there is no code path here that could target, or
 * create, any other row.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const SINGLETON_ID = 1;

const COLUMNS =
  "id, short_desc, address, city, hours, closed, contact_email, site_url, social_instagram, social_facebook, social_line, map_embed, map_link, map_apple, meta_site_name, meta_author, meta_twitter_card, meta_og_type, default_meta_title, default_meta_description, notify_emails, created_at, updated_at";

export type SiteSettingsRow = {
  id: number;
  short_desc: Localized;
  address: Localized;
  city: Localized;
  hours: Localized;
  closed: Localized;
  contact_email: string;
  site_url: string;
  social_instagram: string;
  social_facebook: string;
  social_line: string;
  map_embed: string;
  map_link: string;
  map_apple: string;
  meta_site_name: string;
  meta_author: string;
  meta_twitter_card: string;
  meta_og_type: string;
  default_meta_title: string;
  default_meta_description: string;
  /**
   * 新訂單／新報名通知信收件人（0032）。逗號分隔可填多人，空字串＝不寄。
   * ⚠️ 這一欄對 anon/authenticated **沒有** SELECT 權限（0032 §0.2 的
   * column-level grant）——這裡讀寫的是 service_role（supabaseAdmin()），不受
   * 影響，但別假設這個型別的每一欄都能像 contact_email 一樣被前台的
   * fetchSiteContent() 讀到。
   */
  notify_emails: string;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by updateSiteSettings. No `id` field — the row is always id = 1. */
export type SiteSettingsUpdateInput = {
  short_desc: Localized;
  address: Localized;
  city: Localized;
  hours: Localized;
  closed: Localized;
  contact_email: string;
  site_url: string;
  social_instagram: string;
  social_facebook: string;
  social_line: string;
  map_embed: string;
  map_link: string;
  map_apple: string;
  meta_site_name: string;
  meta_author: string;
  meta_twitter_card: string;
  meta_og_type: string;
  default_meta_title: string;
  default_meta_description: string;
  notify_emails: string;
};

/**
 * Reads the single settings row. Uses .single() rather than .maybeSingle():
 * unlike every other repo in this app, "no row" is not a valid state here —
 * the singleton check(id=1) plus the total absence of any delete() in this
 * file guarantee exactly one row always exists — so a missing row is a real
 * configuration error that should throw, not quietly degrade to null.
 */
export async function getSiteSettings(): Promise<SiteSettingsRow> {
  const { data, error } = await supabaseAdmin()
    .from("site_settings")
    .select(COLUMNS)
    .eq("id", SINGLETON_ID)
    .single();

  if (error) throw new Error(`[repo/site-settings] get 失敗：${error.message}`);
  return data as SiteSettingsRow;
}

/**
 * Updates the single settings row. Deliberately UPDATE-only: no insert() or
 * upsert() exists anywhere in this file, and the target row is always
 * id = 1 rather than something derived from caller input, so there is no way
 * to call this into creating a second row.
 */
export async function updateSiteSettings(input: SiteSettingsUpdateInput): Promise<SiteSettingsRow> {
  const { data, error } = await supabaseAdmin()
    .from("site_settings")
    .update({
      short_desc: input.short_desc,
      address: input.address,
      city: input.city,
      hours: input.hours,
      closed: input.closed,
      contact_email: input.contact_email,
      site_url: input.site_url,
      social_instagram: input.social_instagram,
      social_facebook: input.social_facebook,
      social_line: input.social_line,
      map_embed: input.map_embed,
      map_link: input.map_link,
      map_apple: input.map_apple,
      meta_site_name: input.meta_site_name,
      meta_author: input.meta_author,
      meta_twitter_card: input.meta_twitter_card,
      meta_og_type: input.meta_og_type,
      default_meta_title: input.default_meta_title,
      default_meta_description: input.default_meta_description,
      notify_emails: input.notify_emails,
    })
    .eq("id", SINGLETON_ID)
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/site-settings] update 失敗：${error.message}`);
  return data as SiteSettingsRow;
}
