/**
 * Server functions for the storefront checkout.
 *
 * WHY THESE DO NOT CHAIN adminFnMiddleware
 * ----------------------------------------
 * Every other server function in this app does (see src/lib/admin/fns/*.ts),
 * and src/lib/admin/middleware.ts calls itself THE security boundary. These two
 * are the deliberate exception: a guest has to be able to buy a book without an
 * account, so there is no session to check.
 *
 * Dropping the middleware moves the entire burden onto this file and
 * src/server/repos/orders.ts, so the rules that replace it are worth stating
 * outright:
 *
 *   1. The input is validated by a schema that has no field for money.
 *      checkoutPayloadSchema accepts a product id and a quantity per line and
 *      nothing else — no unit price, no subtotal, no total, no shipping fee,
 *      no product status. There is no value a caller can send that changes what
 *      they are charged, because those numbers are re-read from public.products
 *      on the server. Anyone may POST here; the worst they can do is create an
 *      order for themselves at the real price.
 *
 *   2. Nothing is read back that was not asked for by key. The confirmation
 *      read takes orders.public_token — 24 random bytes — and never accepts an
 *      order number, which is sequential and therefore guessable. It returns no
 *      name, email, phone or address, so even a leaked token exposes amounts
 *      rather than a person.
 *
 *   3. Expected failures are RETURNED, not thrown. A thrown error crosses the
 *      server-function boundary as whatever the framework decides to serialize,
 *      which in production can flatten a precise "not enough stock" into an
 *      opaque 500 and, in the other direction, can carry internal text to the
 *      browser. A discriminated result keeps both from happening.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  checkoutPayloadSchema,
  type CheckoutErrorCode,
  type OrderConfirmation,
} from "@/lib/checkout";

export type PlaceOrderResult =
  | { ok: true; orderNo: string; publicToken: string; total: number }
  | { ok: false; code: CheckoutErrorCode };

export const placeOrder = createServerFn({ method: "POST" })
  .inputValidator(checkoutPayloadSchema)
  .handler(async ({ data }): Promise<PlaceOrderResult> => {
    // Imported inside the handler so the service-role client never appears in
    // the client module graph — the same pattern as the admin functions.
    const { createOrder } = await import("@/server/repos/orders");
    const { CheckoutError } = await import("@/lib/checkout");
    try {
      const order = await createOrder(data);
      return { ok: true, ...order };
    } catch (err) {
      if (err instanceof CheckoutError) return { ok: false, code: err.code };
      console.error("[checkout] placeOrder failed", err);
      return { ok: false, code: "order_failed" };
    }
  });

/**
 * Reads one order back for the confirmation page.
 *
 * Returns null rather than an error for an unknown token: "this token is not an
 * order" and "this token is an order you may not see" must be indistinguishable,
 * or the endpoint becomes an oracle for probing tokens.
 */
export const fetchOrderConfirmation = createServerFn({ method: "GET" })
  .inputValidator(z.object({ token: z.string().trim().min(16).max(200) }))
  .handler(async ({ data }): Promise<OrderConfirmation | null> => {
    const { getOrderByToken } = await import("@/server/repos/orders");
    try {
      return await getOrderByToken(data.token);
    } catch (err) {
      console.error("[checkout] fetchOrderConfirmation failed", err);
      return null;
    }
  });
