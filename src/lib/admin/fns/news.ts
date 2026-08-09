/**
 * news server functions — the only way the admin UI is allowed to touch
 * public.news. Every export chains adminFnMiddleware: that middleware, not
 * the /admin/_shell route guard, is the real authorization boundary (see
 * src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { newsSchema } from "@/lib/admin/schemas";

export const listNews = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listNews } = await import("@/server/repos/news");
    return await listNews();
  });

export const getNewsById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getNewsById } = await import("@/server/repos/news");
    return await getNewsById(data.id);
  });

export const upsertNews = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(newsSchema)
  .handler(async ({ data }) => {
    const { upsertNews } = await import("@/server/repos/news");
    return await upsertNews(data);
  });

export const removeNews = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeNews } = await import("@/server/repos/news");
    await removeNews(data.id);
    return { ok: true };
  });
