/**
 * Authorization middleware for admin server functions.
 *
 * THIS IS THE SECURITY BOUNDARY. The router context and the /admin route guard
 * only affect what the UI shows; neither stops someone POSTing straight to
 * /_serverFn/…  Every admin server function must chain this middleware, and
 * everything under src/server/repos/** assumes its caller already did.
 */
import { createMiddleware } from "@tanstack/react-start";

export const adminFnMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    // Imported inside the handler so the module graph never pulls server-only
    // code toward the client bundle.
    const { requireAdmin } = await import("@/server/auth");
    const admin = await requireAdmin();
    return next({ context: { admin } });
  },
);
