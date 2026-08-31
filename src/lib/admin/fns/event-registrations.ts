/**
 * event_registrations server functions —— 名單的讀取入口。
 *
 * ⚠️ **只有讀，而且只讀得到遮罩過的值。**
 *
 * 沒有 upsert，也沒有 remove，這是刻意的：報名資料只由 reserve_session_seat()
 * 寫、只由 release_session_seat() 與 expire_unpaid_orders() 刪，因為「佔了 N 個
 * 位子」與「有 N 位參加者」必須是同一句 SQL 的兩個面向（0020 §2）。這裡多一支
 * 寫入函式，那個不變量就沒了 —— 而且會是在一個看起來完全無害的地方沒的。
 *
 * 回傳值裡沒有明文 email / phone。要看單列明文是 Phase 2 的
 * reveal_registration_contact()，它在同一個交易裡先寫一筆 public.pii_access_log
 * 才回傳 —— 讀成功 ⇔ 有紀錄。這一期刻意**不做**那條路，因為做了就等於在沒有
 * pii_access_log 對應 reason 的情況下開一條明文出口。
 *
 * 每一支都掛 adminFnMiddleware。名單是第三人的個資，比 CMS 內容更嚴而不是更鬆；
 * Phase 2 會給它自己的第九種 staff 權限 `event.roster.read`，在那之前 admin only
 * 是比較安全的那一邊。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";

export const listSessionRoster = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ sessionId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { listSessionRoster } = await import("@/server/repos/event-registrations");
    return await listSessionRoster(data.sessionId);
  });

export const countRegistrationsBySession = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { countRegistrationsBySession } = await import("@/server/repos/event-registrations");
    return await countRegistrationsBySession();
  });
