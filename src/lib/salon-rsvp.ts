/**
 * 沙龍席位回覆的公開 server function。
 *
 * 表單是公開的，但**寫入不是由瀏覽器直接做的**。public.salon_rsvps 的 RLS 一條
 * policy 都沒給、anon 的權限也全部收回（0037 §2）—— 因為要讓瀏覽器自己 insert，
 * 就得給 anon 一條 insert policy，而有了那條 policy，任何人都能對這張表灌任意
 * 資料。所以走 server fn，在伺服器端用 service role 進來，順便做真正的驗證。
 *
 * 這個形狀與 src/lib/checkout-fns.ts 的 placeOrder 一致：service-role 的 client
 * 只在 handler 裡動態 import，才不會出現在 client 的 module graph 裡。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * 表單這一份：**每一欄都是字串**。
 *
 * 🔴 這裡刻意不寫 `.transform(v => v === "" ? null : v)`。那種寫法會讓 zod 的
 *    input 型別（string）與 output 型別（string | null）不一致，而
 *    react-hook-form 的 useForm<T> 要的是同一個 T —— 兩者對不起來會炸出一整頁
 *    「Type 'FieldValues' is missing the following properties」的錯誤。
 *
 *    而且它本來就不該在這裡：`<input>` 永遠給字串，「沒填」在瀏覽器裡的樣子就是
 *    空字串。空字串該不該變成 null 是**資料庫那一側**的問題，所以那一步放在下面
 *    的 salonRsvpSchema（server fn 的 validator）。
 */
export const salonRsvpFormSchema = z.object({
  eventSlug: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1, "請填寫姓名").max(80),
  organisation: z.string().trim().max(120),
  jobTitle: z.string().trim().max(80),
  phone: z.string().trim().max(40),
  // 這是「行前專屬入場通知」唯一的寄達方式，所以是必填。
  email: z.string().trim().min(1, "請填寫 Email").email("請填寫正確的 Email").max(160),
  attending: z.enum(["yes", "no"]),
  message: z.string().trim().max(1000),
});

export type SalonRsvpValues = z.infer<typeof salonRsvpFormSchema>;

/** 空字串收成 null —— 「沒填」不是「填了空白」。這一步只發生在進資料庫之前。 */
const emptyToNull = (v: string) => (v === "" ? null : v);

/** server fn 的 validator：收表單那個形狀，轉成資料層要的形狀。 */
export const salonRsvpSchema = salonRsvpFormSchema.transform((v) => ({
  eventSlug: v.eventSlug,
  name: v.name,
  organisation: emptyToNull(v.organisation),
  jobTitle: emptyToNull(v.jobTitle),
  phone: emptyToNull(v.phone),
  email: v.email,
  attending: v.attending,
  message: emptyToNull(v.message),
}));

export type SalonRsvpResult = { ok: true } | { ok: false; code: "invalid" | "failed" };

export const submitSalonRsvp = createServerFn({ method: "POST" })
  .inputValidator(salonRsvpSchema)
  .handler(async ({ data }): Promise<SalonRsvpResult> => {
    const { insertSalonRsvp } = await import("@/server/repos/salon-rsvp");

    let saved;
    try {
      saved = await insertSalonRsvp(data);
    } catch {
      // ⚠️ 不要把 error 印出來——那一包裡有回覆人的姓名與電話（見 repo 檔頭）。
      //    repo 已經印過安全的 code 了，這裡只回一個代碼給前端。
      return { ok: false, code: "failed" };
    }

    // ── 通知店家 ────────────────────────────────────────────────────────────
    // 🔴 寄信失敗**不會**讓這次回覆失敗。資料已經寫進去了，那才是正本；為了一封
    //    寄不出去的通知信而告訴使用者「送出失敗」，只會換來他再送一次，於是名單
    //    多一筆重複，而店家仍然沒收到信。信寄不出去的補救是店家自己去看名單。
    try {
      const [{ getSiteSettings }, { sendEmail }] = await Promise.all([
        import("@/server/repos/site-settings"),
        import("@/server/email"),
      ]);
      const settings = await getSiteSettings();
      const to = (settings.notify_emails ?? "").trim();
      if (to) {
        const attending = saved.attending === "yes" ? "確認出席" : "遺憾不克前往";
        const lines = [
          `場次：${saved.event_slug}`,
          `回覆：${attending}`,
          `姓名：${saved.name}`,
          `服務單位：${saved.organisation ?? "（未填）"}`,
          `職稱：${saved.job_title ?? "（未填）"}`,
          `電話：${saved.phone ?? "（未填）"}`,
          `Email：${saved.email}`,
          `期待探討／可提供資源：${saved.message ?? "（未填）"}`,
        ];
        const esc = (s: string) =>
          s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        await sendEmail({
          to,
          subject: `【城市思享沙龍】${attending}：${saved.name}`,
          text: lines.join("\n"),
          html: `<div style="font-family:system-ui,sans-serif;line-height:1.8">${lines
            .map((l) => `<p style="margin:0 0 4px">${esc(l)}</p>`)
            .join("")}</div>`,
        });
      }
    } catch (err) {
      // 這一包是寄信的錯誤，不含回覆人的個資（收件人是店家自己設定的地址），
      // 印出來是安全的，而且不印的話「信一直沒到」會完全查不出原因。
      console.error("[salon-rsvp] 通知信寄送失敗（回覆本身已存檔）", err);
    }

    return { ok: true };
  });
