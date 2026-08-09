/**
 * ui-strings server functions — the only way the admin UI is allowed to
 * touch public.ui_strings. Every export chains adminFnMiddleware: that
 * middleware, not the /admin/_shell route guard, is the real authorization
 * boundary (see src/lib/admin/middleware.ts).
 *
 * Only list + bulk-update exist on purpose: group_key/string_key are
 * consumed by application code and are never created or deleted from the
 * admin (see src/server/repos/ui-strings.ts) — there is no create/remove fn.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { uiStringSchema } from "@/lib/admin/schemas";

export const listUiStrings = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listUiStrings } = await import("@/server/repos/ui-strings");
    return await listUiStrings();
  });

/**
 * Saves every row in one call — the admin page edits all groups on a single
 * page (src/routes/admin/_shell.strings.tsx) and submits the full set at
 * once rather than one round-trip per row. Each array element is validated
 * against uiStringSchema, same as a single-row update would be.
 */
export const updateUiStrings = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.array(uiStringSchema).min(1))
  .handler(async ({ data }) => {
    const { updateUiStrings } = await import("@/server/repos/ui-strings");
    return await updateUiStrings(data);
  });
