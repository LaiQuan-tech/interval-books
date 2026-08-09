/**
 * collaborations server functions — the only way the admin UI is allowed to
 * touch public.collaborations. Every export chains adminFnMiddleware: that
 * middleware, not the /admin/_shell route guard, is the real authorization
 * boundary (see src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { collaborationSchema } from "@/lib/admin/schemas";

export const listCollaborations = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listCollaborations } = await import("@/server/repos/collaborations");
    return await listCollaborations();
  });

export const getCollaborationById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getCollaborationById } = await import("@/server/repos/collaborations");
    return await getCollaborationById(data.id);
  });

export const upsertCollaboration = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(collaborationSchema)
  .handler(async ({ data }) => {
    const { upsertCollaboration } = await import("@/server/repos/collaborations");
    return await upsertCollaboration(data);
  });

export const removeCollaboration = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeCollaboration } = await import("@/server/repos/collaborations");
    await removeCollaboration(data.id);
    return { ok: true };
  });
