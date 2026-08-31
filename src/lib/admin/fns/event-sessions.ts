/**
 * event_sessions server functions — the only way the admin UI is allowed to
 * touch public.event_sessions. Every export chains adminFnMiddleware: that
 * middleware, not the /admin/_shell route guard, is the real authorization
 * boundary (see src/lib/admin/middleware.ts).
 *
 * 為什麼是 adminFnMiddleware 而不是 staffFnMiddleware：開／關一個場次、改名額，
 * 決定的是「這場活動今天收不收得了報名」與「收多少人」。那與 CMS 的其他內容是
 * 同一類決定，不是門市每天的操作。要放寬到店員的時候，那是一次獨立的決定，
 * 應該有自己的一行理由 —— 不是在這裡順手改一個字。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { eventSessionSchema } from "@/lib/admin/schemas";

export const listEventSessions = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listEventSessions } = await import("@/server/repos/event-sessions");
    return await listEventSessions();
  });

/**
 * The event/journey products a session can hang off. Feeds the form's dropdown,
 * which is a dropdown rather than free text so a typo cannot violate
 * event_sessions.product_id's foreign key after submit.
 */
export const listBookableProducts = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
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
