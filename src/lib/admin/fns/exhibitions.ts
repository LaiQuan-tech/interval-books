/**
 * exhibitions server functions — the only way the admin UI is allowed to
 * touch public.exhibitions. Every export chains adminFnMiddleware: that
 * middleware, not the /admin/_shell route guard, is the real authorization
 * boundary (see src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { exhibitionSchema } from "@/lib/admin/schemas";

export const listExhibitions = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listExhibitions } = await import("@/server/repos/exhibitions");
    return await listExhibitions();
  });

export const getExhibitionById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getExhibitionById } = await import("@/server/repos/exhibitions");
    return await getExhibitionById(data.id);
  });

export const upsertExhibition = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(exhibitionSchema)
  .handler(async ({ data }) => {
    const { upsertExhibition } = await import("@/server/repos/exhibitions");
    return await upsertExhibition(data);
  });

export const removeExhibition = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeExhibition } = await import("@/server/repos/exhibitions");
    await removeExhibition(data.id);
    return { ok: true };
  });
