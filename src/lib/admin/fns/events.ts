/**
 * events server functions — the only way the admin UI is allowed to touch
 * public.events. Every export chains adminFnMiddleware: that middleware, not
 * the /admin/_shell route guard, is the real authorization boundary (see
 * src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { eventSchema, eventWithProductSchema } from "@/lib/admin/schemas";

export const listEvents = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listEvents } = await import("@/server/repos/events");
    return await listEvents();
  });

export const getEventById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getEventById } = await import("@/server/repos/events");
    return await getEventById(data.id);
  });

export const upsertEvent = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventSchema)
  .handler(async ({ data }) => {
    const { upsertEvent } = await import("@/server/repos/events");
    return await upsertEvent(data);
  });

/**
 * 建立／更新活動**並且**上架成商品，一個交易。
 *
 * 與上面的 upsertEvent 是兩條路，不是同一條的兩種寫法：這一支走
 * supabase/migrations/0026 的 admin_upsert_event_with_session()，所以
 * 「products.description 取 events.summary」「products.slug = event-<events.slug>」
 * 這兩條投影規則只住在 SQL 那一支函式裡，後台不會有第二份會分岔的抄本。
 */
export const upsertEventWithProduct = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventWithProductSchema)
  .handler(async ({ data }) => {
    const { upsertEventWithProduct } = await import("@/server/repos/events");
    const { product, ...event } = data;
    return await upsertEventWithProduct(event, product ?? null);
  });

/**
 * 每一場活動對應到的那件商品（＋場次數），keyed by events.id。活動列表用它顯示
 * 「已上架／草稿／未上架」，不必一場一場問。
 */
export const listEventProducts = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listEventProducts } = await import("@/server/repos/events");
    return await listEventProducts();
  });

/**
 * 這場活動有幾個場次。場次掛在 products.id 上（0020），不是 events.id ——
 * 所以「沒有商品」與「有商品但還沒排場次」都會是 0，那兩件事在 UI 上分別由
 * listEventProducts() 的 null 與這個 0 表示。
 */
export const countSessionsForEvent = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { countSessionsForEvent } = await import("@/server/repos/events");
    return await countSessionsForEvent(data.id);
  });

export const removeEvent = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeEvent } = await import("@/server/repos/events");
    await removeEvent(data.id);
    return { ok: true };
  });

/**
 * Event counts keyed by category id. events.category has `on delete
 * restrict`, so the event-categories admin page (src/routes/admin/_shell.categories.tsx)
 * uses this to disable deleting a category that still has events attached
 * instead of letting the admin hit a raw Postgres 23503 error.
 */
export const countEventsByCategory = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { countEventsByCategory } = await import("@/server/repos/events");
    return await countEventsByCategory();
  });
