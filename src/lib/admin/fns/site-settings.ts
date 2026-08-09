/**
 * site-settings server functions — the only way the admin UI is allowed to
 * touch public.site_settings. Every export chains adminFnMiddleware: that
 * middleware, not the /admin/_shell route guard, is the real authorization
 * boundary (see src/lib/admin/middleware.ts).
 *
 * Only two functions exist here on purpose: get + update. site_settings is a
 * singleton row that is never created or deleted from the app (see
 * src/server/repos/site-settings.ts), so there is no create/remove fn.
 */
import { createServerFn } from "@tanstack/react-start";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { siteSettingsSchema } from "@/lib/admin/schemas";

export const getSiteSettings = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { getSiteSettings } = await import("@/server/repos/site-settings");
    return await getSiteSettings();
  });

export const updateSiteSettings = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(siteSettingsSchema)
  .handler(async ({ data }) => {
    const { updateSiteSettings } = await import("@/server/repos/site-settings");
    return await updateSiteSettings(data);
  });
