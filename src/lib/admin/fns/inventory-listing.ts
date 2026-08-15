/**
 * 上架的 server functions —— 後台 UI 碰進銷存的唯一入口。
 *
 * 每一支都串 adminFnMiddleware。那個 middleware（而不是 /admin/_shell 的 route
 * guard）才是真正的授權邊界，見 src/lib/admin/middleware.ts。
 *
 * ⚠️ 這幾支比其他後台函式更要緊：它們背後讀的是 inv，而 inv 之所以安全，靠的是
 * 「PostgREST 沒有把它掛出來」這件結構性的事實。0012 建的兩個 view 是刻意開的窗，
 * 只給 service_role，而 service_role 只在這條路徑上出現。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { inventoryListingSchema } from "@/lib/admin/schemas";

export const listInventoryCandidates = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listInventoryCandidates } = await import("@/server/repos/inventory-listing");
    return await listInventoryCandidates();
  });

export const listListedInventoryProducts = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listListedInventoryProducts } = await import("@/server/repos/inventory-listing");
    return await listListedInventoryProducts();
  });

export const createInventoryListing = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(inventoryListingSchema)
  .handler(async ({ data }) => {
    const { createInventoryListing } = await import("@/server/repos/inventory-listing");
    return await createInventoryListing(data);
  });

export const removeInventoryListing = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ product_id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeInventoryListing } = await import("@/server/repos/inventory-listing");
    await removeInventoryListing(data.product_id);
    return { ok: true };
  });
