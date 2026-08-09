/**
 * events server functions — the only way the admin UI is allowed to touch
 * public.events. Every export chains adminFnMiddleware: that middleware, not
 * the /admin/_shell route guard, is the real authorization boundary (see
 * src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { eventSchema } from "@/lib/admin/schemas";

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
