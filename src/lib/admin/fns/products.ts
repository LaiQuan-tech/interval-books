/**
 * products server functions — the only way the admin UI is allowed to touch
 * public.products. Every export chains adminFnMiddleware: that middleware,
 * not the /admin/_shell route guard, is the real authorization boundary (see
 * src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { productSchema } from "@/lib/admin/schemas";

export const listProducts = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listProducts } = await import("@/server/repos/products");
    return await listProducts();
  });

export const getProductById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getProductById } = await import("@/server/repos/products");
    return await getProductById(data.id);
  });

export const upsertProduct = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(productSchema)
  .handler(async ({ data }) => {
    const { upsertProduct } = await import("@/server/repos/products");
    return await upsertProduct(data);
  });

export const removeProduct = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeProduct } = await import("@/server/repos/products");
    await removeProduct(data.id);
    return { ok: true };
  });
