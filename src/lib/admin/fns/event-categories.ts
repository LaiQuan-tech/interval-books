/**
 * event_categories server functions — the only way the admin UI is allowed
 * to touch public.event_categories. Every export chains adminFnMiddleware:
 * that middleware, not the /admin/_shell route guard, is the real
 * authorization boundary (see src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { eventCategorySchema } from "@/lib/admin/schemas";

export const listEventCategories = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listEventCategories } = await import("@/server/repos/event-categories");
    return await listEventCategories();
  });

export const getEventCategoryById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getEventCategoryById } = await import("@/server/repos/event-categories");
    return await getEventCategoryById(data.id);
  });

export const upsertEventCategory = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventCategorySchema)
  .handler(async ({ data }) => {
    const { upsertEventCategory } = await import("@/server/repos/event-categories");
    return await upsertEventCategory(data);
  });

export const removeEventCategory = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeEventCategory } = await import("@/server/repos/event-categories");
    await removeEventCategory(data.id);
    return { ok: true };
  });
