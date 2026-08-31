/**
 * event_sessions server functions — the only way the admin UI is allowed to
 * touch public.event_sessions. Every export chains a middleware: that
 * middleware, not the /admin/_shell route guard, is the real authorization
 * boundary (see src/lib/admin/middleware.ts).
 *
 * ── 寫是 admin，讀是 event.roster.read ───────────────────────────────────
 *
 * **寫**（upsert / remove）維持 adminFnMiddleware。開／關一個場次、改名額，決定的
 * 是「這場活動今天收不收得了報名」與「收多少人」。那與 CMS 的其他內容是同一類
 * 決定，不是門市每天的操作。
 *
 * **讀**（listEventSessions / listBookableProducts）在 0021 放寬到
 * staffFnMiddleware() + event.roster.read。Phase 1 的檔頭說「要放寬到店員的時候，
 * 那是一次獨立的決定，應該有自己的一行理由」—— 這就是那一行：
 *
 *   1. 名單頁需要場次列表才畫得出來。一個被授權看簽到表的人，如果連「有哪幾場」
 *      都讀不到，那個權限等於沒發。
 *   2. 場次本身**已經是公開資訊**：0020 §1 給了 anon `select`（policy 是
 *      status='open' 且商品已上架），因為「這個梯次還剩幾個位子」本來就印在前台
 *      商品頁上。放寬讀取沒有多送出任何一個原本看不到的欄位。
 *   3. 名額的**寫入**仍然只有 admin 與那三支 SQL 函式碰得到，所以「誰能改名額」
 *      一個字都沒變。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware, staffFnMiddleware } from "@/lib/admin/middleware";
import { eventSessionSchema } from "@/lib/admin/schemas";

/** 與 fns/event-registrations.ts 同一支，刻意各寫一份 —— 兩個檔案的訊息各自演進。 */
async function requireRosterRead(permissions: readonly string[]): Promise<void> {
  if (permissions.includes("event.roster.read")) return;
  const { NotAuthorizedError } = await import("@/server/auth");
  throw new NotAuthorizedError("需要「查看活動報名名單」權限");
}

export const listEventSessions = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async ({ context }) => {
    await requireRosterRead(context.staff.permissions);
    const { listEventSessions } = await import("@/server/repos/event-sessions");
    return await listEventSessions();
  });

/**
 * The event/journey products a session can hang off. Feeds the form's dropdown,
 * which is a dropdown rather than free text so a typo cannot violate
 * event_sessions.product_id's foreign key after submit.
 */
export const listBookableProducts = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async ({ context }) => {
    await requireRosterRead(context.staff.permissions);
    const { listBookableProducts } = await import("@/server/repos/event-sessions");
    return await listBookableProducts();
  });

export const upsertEventSession = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventSessionSchema)
  .handler(async ({ data }) => {
    const { upsertEventSession } = await import("@/server/repos/event-sessions");
    return await upsertEventSession(data);
  });

/**
 * Deletes a sitting.
 *
 * Fails loudly when anyone has ever booked it (both event_registrations and
 * order_items reference it `on delete restrict`). The repo passes the Postgres
 * message straight through and the page shows it in a toast — see the repo for
 * why that is better than a friendlier invented sentence.
 */
export const removeEventSession = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeEventSession } = await import("@/server/repos/event-sessions");
    await removeEventSession(data.id);
    return { ok: true };
  });
