/**
 * public.salon_rsvps 的資料層（0037）。
 *
 * 沙龍的席位回覆：不收錢、審核制、15 席。它刻意**不**走 event_registrations ——
 * 那一套的每一列都掛著 order_id / order_item_id，名額由 0020 的三支加鎖 RPC 維護；
 * 這裡沒有訂單、沒有金額、也不扣名額，而且「遺憾不克前往」在那套語彙裡根本不是
 * 一種報名。理由完整寫在 supabase/migrations/0037_salon_rsvp.sql 的 §0。
 *
 * ⚠️ **這張表整張都是個資**（姓名／服務單位／職稱／電話／email）。與
 *    src/server/repos/event-registrations.ts 同一條紀律：出錯時只印
 *    `error.code` 與 `error.message`，**不要印整包 error** —— PostgREST 會把
 *    `DETAIL: Failing row contains (…)` 一起帶上來，那一行就是回覆人的姓名與電話，
 *    印進 log 就等於把個資寫進一個沒有人在管存取權限的地方。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

export type SalonRsvpInput = {
  eventSlug: string;
  name: string;
  organisation: string | null;
  jobTitle: string | null;
  phone: string | null;
  email: string;
  attending: "yes" | "no";
  message: string | null;
};

export type SalonRsvpRow = {
  id: string;
  event_slug: string;
  name: string;
  organisation: string | null;
  job_title: string | null;
  phone: string | null;
  email: string;
  attending: "yes" | "no";
  message: string | null;
  created_at: string;
};

/**
 * 寫一筆回覆。
 *
 * 刻意**不**去重：同一個人可能先回「不克前往」之後改成「確認出席」，用 email 當
 * 唯一鍵會讓那個更正變成一個他看不懂的錯誤。重複由讀的人依 created_at 判斷，
 * 最後一筆為準（0037 的表註解有寫）。
 */
export async function insertSalonRsvp(input: SalonRsvpInput): Promise<SalonRsvpRow> {
  const { data, error } = await supabaseAdmin()
    .from("salon_rsvps")
    .insert({
      event_slug: input.eventSlug,
      name: input.name,
      organisation: input.organisation,
      job_title: input.jobTitle,
      phone: input.phone,
      email: input.email,
      attending: input.attending,
      message: input.message,
    })
    .select(
      "id, event_slug, name, organisation, job_title, phone, email, attending, message, created_at",
    )
    .single();

  if (error) {
    console.error(`[repo/salon-rsvp] insert 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/salon-rsvp] 席位回覆寫入失敗：${error.code}`);
  }
  return data as unknown as SalonRsvpRow;
}

/** 後台／人工要看名單時用。依 created_at 由新到舊。 */
export async function listSalonRsvps(eventSlug: string): Promise<SalonRsvpRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("salon_rsvps")
    .select(
      "id, event_slug, name, organisation, job_title, phone, email, attending, message, created_at",
    )
    .eq("event_slug", eventSlug)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    console.error(`[repo/salon-rsvp] list 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/salon-rsvp] 席位回覆讀取失敗：${error.code}`);
  }
  return (data ?? []) as unknown as SalonRsvpRow[];
}
