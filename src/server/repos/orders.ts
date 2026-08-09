/**
 * Data layer for the checkout tables (orders / order_items / order_addresses).
 *
 * WHY THIS FILE IS THE ONLY WAY IN
 * --------------------------------
 * supabase/migrations/0005_commerce_orders.sql turns RLS on for all eight
 * commerce tables and creates **zero policies**, then revokes every grant from
 * anon and authenticated. There is no query the browser can write that reaches
 * these tables — not a select, not an insert. service_role bypasses RLS, so
 * this module (and only this module) can touch them, and it is reachable only
 * from src/lib/checkout-fns.ts.
 *
 * That also means the usual safety net is gone: the database will not
 * second-guess anything sent from here. Every rule the checkout depends on —
 * what a line costs, whether a product is on sale, how much shipping is — is
 * enforced *in this file*, from values re-read out of public.products. The
 * browser's only contribution is a list of (product_id, quantity) pairs.
 *
 * THERE IS NO TRANSACTION HERE, AND THAT SHAPES THE ORDER OF OPERATIONS
 * --------------------------------------------------------------------
 * PostgREST gives one statement per round trip; `begin … commit` around four
 * writes is not available. So the sequence below is arranged so that the only
 * step that can leave the database wrong is the last one, and everything
 * before it is undoable:
 *
 *   1. read products, recompute money, pre-check availability   (no writes)
 *   2. insert orders                                            (undo: delete)
 *   3. insert order_items                                       (undo: cascade)
 *   4. insert order_addresses                                   (undo: cascade)
 *   5. reserve seats, one reserve_product_seat() per booking     (undo: CAS)
 *   6. atomic_deduct_stock() for every stock-managed line        (no undo needed)
 *
 * Deleting the orders row cascades to order_items and order_addresses (both
 * declare `on delete cascade`), so undoing 2–4 is a single delete. Step 6 is
 * last on purpose: it is all-or-nothing inside one function call, so if it
 * raises, no stock moved, and there is no later step that could fail after it
 * succeeded. That is what makes "restore the stock" a case that cannot arise.
 *
 * Step 5 is the one genuinely awkward part — reserve_product_seat() takes one
 * product at a time, so an order with two different bookings is two calls and
 * the second can fail after the first succeeded. releaseSeats() below undoes it
 * with a compare-and-swap rather than a relative update, because a
 * read-modify-write on seats_taken is exactly the oversell bug that
 * atomic_deduct_stock() exists to prevent.
 *
 * Net effect: a failed checkout leaves **no** orders row, hence no order_items
 * and no order_addresses, and leaves stock and seats where they were.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";
import {
  CheckoutError,
  computeShippingFee,
  type CheckoutPayload,
  type OrderConfirmation,
  type ProductTypeForOrder,
  type ShippingMethod,
} from "@/lib/checkout";

/** Columns checkout needs from public.products. Price is re-read, never trusted. */
const PRODUCT_COLUMNS =
  "id, product_type, title, price, stock, capacity, seats_taken, requires_shipping, status";

type ProductRow = {
  id: string;
  product_type: ProductTypeForOrder;
  title: Localized;
  price: number;
  stock: number | null;
  capacity: number | null;
  seats_taken: number;
  requires_shipping: boolean;
  status: string;
};

/** A line after the server has priced it. Nothing here came from the browser except `quantity`. */
type PricedLine = {
  productId: string;
  productType: ProductTypeForOrder;
  name: Localized;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  requiresShipping: boolean;
};

export type PlacedOrder = {
  orderNo: string;
  /** Unguessable lookup key. Returned exactly once, here — never by a status read. */
  publicToken: string;
  total: number;
};

/** Shaped by src/lib/checkout.ts so the route and the repo cannot drift. */
export type OrderSummary = OrderConfirmation;

const isBooking = (t: ProductTypeForOrder) => t === "event" || t === "journey";

// -----------------------------------------------------------------------------
// Pricing — the part a tampered payload must not be able to reach
// -----------------------------------------------------------------------------

/**
 * Turns the browser's (product_id, quantity) list into priced lines using the
 * database's own numbers.
 *
 * `.eq("status", "active")` is load-bearing rather than cosmetic here: this
 * runs on service_role, which bypasses the products_select_public policy, so a
 * draft or archived id would otherwise be sellable through the checkout even
 * though it is invisible on the storefront.
 *
 * Duplicate product ids in the payload are merged rather than rejected — two
 * lines for the same product are indistinguishable from one line of the summed
 * quantity, and atomic_deduct_stock() would otherwise deduct them as two
 * independent lines against the same row.
 */
async function priceLines(items: CheckoutPayload["items"]): Promise<PricedLine[]> {
  const wanted = new Map<string, number>();
  for (const item of items) {
    wanted.set(item.productId, (wanted.get(item.productId) ?? 0) + item.quantity);
  }
  if (wanted.size === 0) throw new CheckoutError("cart_empty");

  const { data, error } = await supabaseAdmin()
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("status", "active")
    .in("id", [...wanted.keys()]);

  if (error) throw new CheckoutError("order_failed");

  const rows = (data ?? []) as unknown as ProductRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Every requested id must still be on sale. Reporting the whole cart as
  // unavailable rather than silently dropping the line is deliberate: dropping
  // it would charge the shopper for an order they did not agree to.
  const lines: PricedLine[] = [];
  for (const [productId, quantity] of wanted) {
    const p = byId.get(productId);
    if (!p) throw new CheckoutError("product_unavailable");
    lines.push({
      productId: p.id,
      productType: p.product_type,
      name: p.title,
      unitPrice: p.price,
      quantity,
      subtotal: p.price * quantity,
      requiresShipping: p.requires_shipping,
    });
  }

  // Cheap, write-free rejection of the common cases, so an ordinary "sold out"
  // never burns an order number. It is NOT the real guard — steps 5 and 6 are,
  // and they still have to handle the racing shopper this check cannot see.
  for (const line of lines) {
    const p = byId.get(line.productId)!;
    if (isBooking(p.product_type)) {
      if (p.capacity !== null && p.seats_taken + line.quantity > p.capacity) {
        throw new CheckoutError("no_seats_left");
      }
    } else if (p.stock !== null && p.stock < line.quantity) {
      throw new CheckoutError("insufficient_stock");
    }
  }

  return lines;
}

// -----------------------------------------------------------------------------
// Seat rollback
// -----------------------------------------------------------------------------

/**
 * Give back seats claimed by reserve_product_seat() when a later step failed.
 *
 * Compare-and-swap, not `seats_taken = seats_taken - n`: PostgREST can only
 * send an absolute value, and writing back a number read a moment ago is how
 * two concurrent bookings overwrite each other. Filtering the PATCH on the
 * observed value means a row someone else touched in between simply matches
 * nothing, and we re-read and try again.
 *
 * Best effort by design. This runs while another error is already being
 * reported, so it must never throw and mask it; the worst case is a seat that
 * stays counted until someone looks, which is far better than a seat sold twice.
 */
async function releaseSeats(reserved: { productId: string; quantity: number }[]): Promise<void> {
  const db = supabaseAdmin();
  for (const { productId, quantity } of reserved) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data: current } = await db
          .from("products")
          .select("seats_taken")
          .eq("id", productId)
          .maybeSingle();
        const taken = (current as { seats_taken?: number } | null)?.seats_taken;
        if (typeof taken !== "number") break;

        const next = Math.max(0, taken - quantity);
        const { data: updated } = await db
          .from("products")
          .update({ seats_taken: next })
          .eq("id", productId)
          .eq("seats_taken", taken) // ← the compare half of compare-and-swap
          .select("id");
        if (Array.isArray(updated) && updated.length > 0) break;
      } catch {
        break;
      }
    }
  }
}

/**
 * Narrows the payload's address to one that can actually be delivered to.
 *
 * checkoutPayloadSchema keeps every address field optional, because whether an
 * address is needed at all depends on products.requires_shipping — a fact the
 * schema cannot see. So the required-ness is asserted here instead, where the
 * cart has been priced and the answer is known. Returning null rather than
 * throwing lets the caller decide whether a missing address is a problem.
 */
function completeAddress(
  a: CheckoutPayload["address"],
): { recipient: string; phone: string; postalCode: string | null; city: string; district: string | null; street: string } | null {
  const recipient = a?.recipient?.trim();
  const phone = a?.phone?.trim();
  const city = a?.city?.trim();
  const street = a?.street?.trim();
  if (!recipient || !phone || !city || !street) return null;
  return {
    recipient,
    phone,
    city,
    street,
    postalCode: a?.postalCode?.trim() || null,
    district: a?.district?.trim() || null,
  };
}

/** Undo steps 2–4. order_items and order_addresses go with it via `on delete cascade`. */
async function deleteOrder(orderId: string): Promise<void> {
  try {
    await supabaseAdmin().from("orders").delete().eq("id", orderId);
  } catch {
    /* best effort — see releaseSeats() */
  }
}

// -----------------------------------------------------------------------------
// createOrder
// -----------------------------------------------------------------------------

/**
 * Creates a pending, unpaid order.
 *
 * `status` and `payment_status` are both left at their 'pending' defaults and
 * `payment_method` at NULL: this is where PayUni will attach, and until it does
 * an order here means "we have your details and your stock is held", not "you
 * have paid". Nothing in this file may ever set payment_status = 'paid'; that
 * belongs to the webhook path, which is the only party that knows.
 */
export async function createOrder(payload: CheckoutPayload): Promise<PlacedOrder> {
  const db = supabaseAdmin();

  // ---- step 0: has this exact attempt already succeeded? --------------------
  // This has to come before the availability pre-check, not after. A replay is
  // most likely to arrive precisely when the first attempt consumed the last
  // unit — a double-clicked button on the last copy of a book — and if pricing
  // ran first, the shopper would be told "out of stock" about an order that had
  // in fact gone through. The 23505 handler further down is the backstop for
  // two replays racing each other; this is the one that fires in practice.
  const replay = await findByIdempotencyKey(payload.idempotencyKey);
  if (replay) return replay;

  const lines = await priceLines(payload.items);

  // Shipping is decided by the products, not by the form. A cart of nothing but
  // bookings collects no address and pays no freight; see computeShippingFee().
  const needsShipping = lines.some((l) => l.requiresShipping);

  // A tampered payload must not be able to talk its way out of freight. An
  // unrecognised method on a cart that does need posting falls back to `home`
  // — the most expensive option — rather than to `none`, and `none` is only
  // ever reachable by having no shippable product in the cart at all.
  const shippingMethod: ShippingMethod = !needsShipping
    ? "none"
    : payload.shippingMethod === "pickup"
      ? "pickup"
      : "home";

  const needsAddress = shippingMethod === "home";
  const address = needsAddress ? completeAddress(payload.address) : null;
  if (needsAddress && !address) throw new CheckoutError("shipping_address_required");

  const subtotal = lines.reduce((sum, l) => sum + l.subtotal, 0);
  const shippingFee = computeShippingFee({ needsShipping, method: shippingMethod, subtotal });
  const discount = 0; // no coupon mechanism yet; the column exists for one
  const total = subtotal + shippingFee - discount;

  // ---- step 2: orders -------------------------------------------------------
  const { data: inserted, error: orderError } = await db
    .from("orders")
    .insert({
      customer_name: payload.customerName,
      customer_email: payload.customerEmail,
      customer_phone: payload.customerPhone,
      subtotal,
      shipping_fee: shippingFee,
      discount,
      total,
      shipping_method: shippingMethod,
      idempotency_key: payload.idempotencyKey,
      locale: payload.locale,
      note: payload.note ?? null,
    })
    .select("id, order_no, public_token, total")
    .single();

  if (orderError || !inserted) {
    // 23505 on idempotency_key means this exact checkout attempt already
    // succeeded — a double-clicked button or a retried request, not a new
    // order. Returning the original is the whole point of the column; treating
    // it as an error would reserve the stock twice.
    if (orderError?.code === "23505") {
      const existing = await findByIdempotencyKey(payload.idempotencyKey);
      if (existing) return existing;
    }
    throw new CheckoutError("order_failed");
  }

  const order = inserted as unknown as {
    id: string;
    order_no: string;
    public_token: string;
    total: number;
  };
  const reserved: { productId: string; quantity: number }[] = [];

  try {
    // ---- step 3: order_items ------------------------------------------------
    // Built by one mapper so every object carries an identical key set.
    // PostgREST rejects a batch whose objects differ ("All object keys must
    // match") — adding, say, product_id to only the rows that have one turns
    // the whole insert into a 400.
    const { error: itemsError } = await db.from("order_items").insert(
      lines.map((l) => ({
        order_id: order.id,
        product_id: l.productId,
        name: l.name,
        unit_price: l.unitPrice,
        quantity: l.quantity,
        subtotal: l.subtotal,
        product_type: l.productType,
      })),
    );
    if (itemsError) throw new CheckoutError("order_failed");

    // ---- step 4: order_addresses -------------------------------------------
    if (address) {
      const { error: addressError } = await db.from("order_addresses").insert({
        order_id: order.id,
        type: "shipping",
        recipient: address.recipient,
        phone: address.phone,
        postal_code: address.postalCode,
        city: address.city,
        district: address.district,
        street: address.street,
      });
      if (addressError) throw new CheckoutError("order_failed");
    }

    // ---- step 5: seats ------------------------------------------------------
    // Sorted so concurrent multi-booking orders take the row locks in the same
    // order and cannot deadlock against each other — the same reasoning
    // atomic_deduct_stock() applies internally.
    for (const line of lines.filter((l) => isBooking(l.productType)).sort((a, b) =>
      a.productId < b.productId ? -1 : 1,
    )) {
      const { error } = await db.rpc("reserve_product_seat", {
        p_product_id: line.productId,
        p_quantity: line.quantity,
      });
      if (error) throw new CheckoutError("no_seats_left");
      reserved.push({ productId: line.productId, quantity: line.quantity });
    }

    // ---- step 6: stock ------------------------------------------------------
    // One call for every stock-managed line, so it is one transaction: either
    // the whole cart is deducted or none of it is. Never split this into a loop.
    const stockLines = lines.filter((l) => !isBooking(l.productType));
    if (stockLines.length > 0) {
      const { error } = await db.rpc("atomic_deduct_stock", {
        p_items: stockLines.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
      });
      // A product whose stock is NULL is not stock-managed and must not be
      // rejected for it — atomic_deduct_stock() cannot tell that apart from a
      // shortfall, so those lines are filtered out before it is called.
      if (error) throw new CheckoutError("insufficient_stock");
    }
  } catch (err) {
    await releaseSeats(reserved);
    await deleteOrder(order.id);
    throw err instanceof CheckoutError ? err : new CheckoutError("order_failed");
  }

  return { orderNo: order.order_no, publicToken: order.public_token, total: order.total };
}

/**
 * Only ever called after a 23505 on idempotency_key, so "not found" here means
 * the conflict was on some other unique column and the caller should report a
 * plain failure rather than invent a success.
 */
async function findByIdempotencyKey(key: string): Promise<PlacedOrder | null> {
  const { data } = await supabaseAdmin()
    .from("orders")
    .select("order_no, public_token, total")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as { order_no: string; public_token: string; total: number };
  return { orderNo: row.order_no, publicToken: row.public_token, total: row.total };
}

// -----------------------------------------------------------------------------
// Reading an order back
// -----------------------------------------------------------------------------

/**
 * The guest-facing order read, keyed on the unguessable public_token.
 *
 * Deliberately narrow. It returns no customer name, email, phone or address,
 * and it does not echo the token back (0005 says so in as many words): a
 * confirmation page needs the order number and the amounts, and anything more
 * is PII sitting behind a string that ends up in browser history, referrer
 * headers and shoulder-surfing range.
 */
export async function getOrderByToken(token: string): Promise<OrderSummary | null> {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("orders")
    .select(
      "id, order_no, status, payment_status, subtotal, shipping_fee, discount, total, shipping_method, created_at",
    )
    .eq("public_token", token)
    .maybeSingle();
  if (error || !data) return null;

  const o = data as unknown as {
    id: string;
    order_no: string;
    status: string;
    payment_status: string;
    subtotal: number;
    shipping_fee: number;
    discount: number;
    total: number;
    shipping_method: ShippingMethod;
    created_at: string;
  };

  const { data: itemRows } = await db
    .from("order_items")
    .select("name, unit_price, quantity, subtotal, product_type")
    .eq("order_id", o.id)
    .order("id", { ascending: true });

  const items = ((itemRows ?? []) as unknown as {
    name: Localized;
    unit_price: number;
    quantity: number;
    subtotal: number;
    product_type: ProductTypeForOrder;
  }[]).map((r) => ({
    name: r.name,
    unitPrice: r.unit_price,
    quantity: r.quantity,
    subtotal: r.subtotal,
    productType: r.product_type,
  }));

  return {
    orderNo: o.order_no,
    status: o.status,
    paymentStatus: o.payment_status,
    subtotal: o.subtotal,
    shippingFee: o.shipping_fee,
    discount: o.discount,
    total: o.total,
    shippingMethod: o.shipping_method,
    createdAt: o.created_at,
    items,
  };
}
