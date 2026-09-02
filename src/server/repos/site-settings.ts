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
  "id, short_desc, address, city, hours, closed, contact_email, site_url, social_instagram, social_facebook, social_line, map_embed, map_link, map_apple, meta_site_name, meta_author, meta_twitter_card, meta_og_type, default_meta_title, default_meta_description, notify_emails, bank_name, bank_code, bank_account, bank_account_name, created_at, updated_at";

/** 匯款帳戶那四欄（0034 §1）。單獨列出來，因為 getRemittanceAccount() 只讀它們。 */
const BANK_COLUMNS = "bank_name, bank_code, bank_account, bank_account_name";

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
  /**
   * 匯款帳戶（0034 §1）。⚠️ 與 notify_emails 一樣，這四欄對 anon/authenticated
   * **沒有** SELECT 權限——前台拿得到它們是因為完成頁的 server function 走
   * service_role 讀出來夾在回應裡，不是瀏覽器自己查表。
   *
   * ⚠️ 寫入端（後台設定頁的四個欄位）**故意還沒做**：那是後台那一輪的事。
   *    SiteSettingsUpdateInput 因此沒有這四個 key，update() 也就不會碰它們——
   *    現有的設定頁存檔不會把它們清成空字串。
   */
  bank_name: string;
  bank_code: string;
  bank_account: string;
  bank_account_name: string;
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
 * 匯款帳戶（0034）。
 *
 * ⚠️ 與 getSiteSettings() 不同，**這一支不 throw**。它的兩個呼叫端都在不可以因此
 *    失敗的路徑上：
 *      · src/server/notify.ts 的下單當下寄信 —— 那條路的規約是「絕不拖垮訂單成立」；
 *      · 完成頁的 server function —— 讀不到帳戶只該讓那一區塊不顯示，不該讓整張
 *        訂單頁變成「找不到這筆訂單」。
 *    讀不到就回 null，呼叫端自己決定要顯示什麼。錯誤留在 log 裡。
 *
 * 回傳的四個字串已經 trim 過；四欄都空（＝店家還沒設定）也照樣回物件，
 * 「有沒有設定完整」由 src/lib/checkout.ts 的 remittanceConfigured() 判斷 ——
 * 那條判準只有一份，不在這裡重寫第二份。
 */
export async function getRemittanceAccount(): Promise<{
  bankName: string;
  bankCode: string;
  bankAccount: string;
  accountName: string;
} | null> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("site_settings")
      .select(BANK_COLUMNS)
      .eq("id", SINGLETON_ID)
      .maybeSingle();

    if (error) {
      console.error(`[repo/site-settings] 讀匯款帳戶失敗：${error.code} ${error.message}`);
      return null;
    }
    if (!data) return null;

    const row = data as unknown as Record<string, unknown>;
    const str = (v: unknown) => String(v ?? "").trim();
    return {
      bankName: str(row.bank_name),
      bankCode: str(row.bank_code),
      bankAccount: str(row.bank_account),
      accountName: str(row.bank_account_name),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[repo/site-settings] 讀匯款帳戶發生例外：${message}`);
    return null;
  }
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
