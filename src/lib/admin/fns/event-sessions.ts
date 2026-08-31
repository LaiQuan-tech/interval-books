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
 *   2. 名額的**寫入**仍然只有 admin 與那三支 SQL 函式碰得到，所以「誰能改名額」
 *      一個字都沒變。
 *
 * ⚠️ **這個放寬確實多送出了一點東西，不要說它沒有。**
 *
 *    這兩支的過濾條件比 anon 寬：`listEventSessions()` 回**全部**場次（含
 *    `status='closed'`），而 anon 的 policy 是 `status='open'` 且商品已上架；
 *    `listBookableProducts()` 回**全部** status 的 event／journey 商品（那支 repo
 *    自己的註解就寫著 "Every status, not just active"，因為場次通常要在商品上架
 *    之前就先建好），而 anon 只看得到 `status='active'`。
 *
 *    所以拿到 event.roster.read 的人會看到「還沒公開的活動叫什麼名字、預計開幾
 *    梯」。判斷是：這些人是店主明確授權去現場點名的內部同事，而洩漏面是**未上架
 *    活動的標題**，不是任何人的個資 —— 可以接受。但如果哪天這個權限要發給更外圍
 *    的人（工讀生、場地方、講師），這一段就是要重讀的地方：那時候正確的做法是把
 *    `listBookableProducts` 收回 adminFnMiddleware（建場次的下拉選單本來就只有
 *    admin 會用），畫面上的商品名稱改由場次自己帶。
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
