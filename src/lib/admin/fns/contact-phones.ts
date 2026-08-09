/**
 * contact-phones server functions — the only way the admin UI is allowed to
 * touch public.contact_phones. Every export chains adminFnMiddleware: that
 * middleware, not the /admin/_shell route guard, is the real authorization
 * boundary (see src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { contactPhoneSchema } from "@/lib/admin/schemas";

export const listContactPhones = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listContactPhones } = await import("@/server/repos/contact-phones");
    return await listContactPhones();
  });

export const getContactPhoneById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.number().int() }))
  .handler(async ({ data }) => {
    const { getContactPhoneById } = await import("@/server/repos/contact-phones");
    return await getContactPhoneById(data.id);
  });

export const upsertContactPhone = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(contactPhoneSchema)
  .handler(async ({ data }) => {
    const { upsertContactPhone } = await import("@/server/repos/contact-phones");
    return await upsertContactPhone(data);
  });

export const removeContactPhone = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.number().int() }))
  .handler(async ({ data }) => {
    const { removeContactPhone } = await import("@/server/repos/contact-phones");
    await removeContactPhone(data.id);
    return { ok: true };
  });
