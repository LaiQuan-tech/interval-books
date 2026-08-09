/**
 * curated (themes + items) server functions — the only way the admin UI is
 * allowed to touch public.curated_themes / public.curated_items. Every export
 * chains adminFnMiddleware: that middleware, not the /admin/_shell route
 * guard, is the real authorization boundary (see src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { curatedThemeSchema, curatedItemSchema } from "@/lib/admin/schemas";

export const listCuratedThemes = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listCuratedThemes } = await import("@/server/repos/curated");
    return await listCuratedThemes();
  });

export const getCuratedThemeById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getCuratedThemeById } = await import("@/server/repos/curated");
    return await getCuratedThemeById(data.id);
  });

export const upsertCuratedTheme = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(curatedThemeSchema)
  .handler(async ({ data }) => {
    const { upsertCuratedTheme } = await import("@/server/repos/curated");
    return await upsertCuratedTheme(data);
  });

export const removeCuratedTheme = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeCuratedTheme } = await import("@/server/repos/curated");
    await removeCuratedTheme(data.id);
    return { ok: true };
  });

export const listCuratedItems = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ theme_id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { listCuratedItemsByTheme } = await import("@/server/repos/curated");
    return await listCuratedItemsByTheme(data.theme_id);
  });

export const getCuratedItemById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.number().int() }))
  .handler(async ({ data }) => {
    const { getCuratedItemById } = await import("@/server/repos/curated");
    return await getCuratedItemById(data.id);
  });

export const upsertCuratedItem = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(curatedItemSchema)
  .handler(async ({ data }) => {
    const { upsertCuratedItem } = await import("@/server/repos/curated");
    return await upsertCuratedItem(data);
  });

export const removeCuratedItem = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.number().int() }))
  .handler(async ({ data }) => {
    const { removeCuratedItem } = await import("@/server/repos/curated");
    await removeCuratedItem(data.id);
    return { ok: true };
  });

/**
 * Reorders items within a theme. `ids` must be the full, desired-order list
 * of item ids for that theme — see src/server/repos/curated.ts#reorderCuratedItems
 * for why this goes through the admin_reorder_curated_items RPC instead of
 * per-row updates.
 */
export const reorderCuratedItems = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      theme_id: z.string().trim().min(1),
      ids: z.array(z.number().int()).min(1),
    }),
  )
  .handler(async ({ data }) => {
    const { reorderCuratedItems } = await import("@/server/repos/curated");
    await reorderCuratedItems(data.theme_id, data.ids);
    return { ok: true };
  });
