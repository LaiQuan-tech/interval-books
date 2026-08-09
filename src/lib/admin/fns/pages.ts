/**
 * pages (+ page_blocks + page_list_items) server functions — the only way the
 * admin UI is allowed to touch public.pages / public.page_blocks /
 * public.page_list_items. Every export chains adminFnMiddleware: that
 * middleware, not the /admin/_shell route guard, is the real authorization
 * boundary (see src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { pageMetaSchema, pageBlocksBulkSchema, pageListItemSchema } from "@/lib/admin/schemas";

export const listPages = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listPages } = await import("@/server/repos/pages");
    return await listPages();
  });

export const getPageBySlug = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ slug: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getPageBySlug } = await import("@/server/repos/pages");
    return await getPageBySlug(data.slug);
  });

export const updatePageMeta = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(pageMetaSchema)
  .handler(async ({ data }) => {
    const { updatePageMeta } = await import("@/server/repos/pages");
    return await updatePageMeta(data);
  });

export const listPageBlocks = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ page_slug: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { listPageBlocks } = await import("@/server/repos/pages");
    return await listPageBlocks(data.page_slug);
  });

/**
 * Bulk-saves every block value on one page in a single call — the "文案區塊"
 * section submits its whole (fixed-length) blocks array at once rather than
 * one server round-trip per field. See src/server/repos/pages.ts#bulkUpdatePageBlocks
 * for why this can never add/remove a block_key.
 */
export const updatePageBlocks = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(pageBlocksBulkSchema)
  .handler(async ({ data }) => {
    const { bulkUpdatePageBlocks } = await import("@/server/repos/pages");
    return await bulkUpdatePageBlocks(data.page_slug, data.blocks);
  });

export const listPageListItems = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ page_slug: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { listPageListItems } = await import("@/server/repos/pages");
    return await listPageListItems(data.page_slug);
  });

export const upsertPageListItem = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(pageListItemSchema)
  .handler(async ({ data }) => {
    const { upsertPageListItem } = await import("@/server/repos/pages");
    return await upsertPageListItem(data);
  });

export const removePageListItem = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.number().int() }))
  .handler(async ({ data }) => {
    const { removePageListItem } = await import("@/server/repos/pages");
    await removePageListItem(data.id);
    return { ok: true };
  });

/**
 * Reorders items within one page_slug + list_key group. `ids` must be the
 * full, desired-order list of item ids for that group — see
 * src/server/repos/pages.ts#reorderPageListItems for why this goes through
 * the admin_reorder_page_list_items RPC instead of per-row updates.
 */
export const reorderPageListItems = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      page_slug: z.string().trim().min(1),
      list_key: z.string().trim().min(1),
      ids: z.array(z.number().int()).min(1),
    }),
  )
  .handler(async ({ data }) => {
    const { reorderPageListItems } = await import("@/server/repos/pages");
    await reorderPageListItems(data.page_slug, data.list_key, data.ids);
    return { ok: true };
  });
