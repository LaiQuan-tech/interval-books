/**
 * journeys server functions — the only way the admin UI is allowed to touch
 * public.journeys. Every export chains adminFnMiddleware: that middleware,
 * not the /admin/_shell route guard, is the real authorization boundary (see
 * src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { journeySchema } from "@/lib/admin/schemas";

export const listJourneys = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listJourneys } = await import("@/server/repos/journeys");
    return await listJourneys();
  });

export const getJourneyById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getJourneyById } = await import("@/server/repos/journeys");
    return await getJourneyById(data.id);
  });

export const upsertJourney = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(journeySchema)
  .handler(async ({ data }) => {
    const { upsertJourney } = await import("@/server/repos/journeys");
    return await upsertJourney(data);
  });

export const removeJourney = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeJourney } = await import("@/server/repos/journeys");
    await removeJourney(data.id);
    return { ok: true };
  });
