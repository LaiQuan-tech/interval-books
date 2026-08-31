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
 *  4b. insert invoices (the shopper's invoice choice)            (undo: cascade)
 *   5. reserve_session_seat() per booking line                   (undo: delete)
 *  6a. reserve_inventory_stock() for inventory-backed lines      (undo: delete)
 *  6b. atomic_deduct_stock() for every catalog-stock line        (no undo needed)
 *   7. record the payment intent and build the gateway hand-off (see below)
 *
 * Deleting the orders row cascades to order_items, order_addresses and invoices
 * (all three declare `on delete cascade`), so undoing 2–4b is a single delete.
 * Step 6b is
 * last on purpose: it is all-or-nothing inside one function call, so if it
 * raises, no stock moved, and there is no later step that could fail after it
 * succeeded. That is what makes "restore the stock" a case that cannot arise.
 *
 * Step 6a is new (migration 0011) and sits in front of 6b rather than replacing
 * it, because the two manage different products: 6b owns the ones whose stock
 * lives in public.products, 6a owns the ones sold out of the shop's real
 * inventory (inv.products). A product is never both — 0011 has a trigger that
 * refuses to let a linked product carry a catalog stock number at all.
 *
 * 6a is placed before 6b specifically because it is the undoable one. It writes
 * only to stock_reservations and never moves physical stock, so its rollback is
 * a delete rather than a compensating write — which means an abandoned checkout
 * leaves the inventory system with no sales row and no stock movement at all.
 * That is the property this whole design exists to buy; see 0011's header.
 *
 * Step 5 changed shape in migration 0020 and is worth re-reading. It used to be
 * reserve_product_seat(product_id, quantity), which moved a counter on
 * public.products and nothing else. It is now
 * reserve_session_seat(order_id, order_item_id, session_id, quantity,
 * participants) — one call that takes the seats on public.event_sessions AND
 * writes the N attendee rows, in one statement.
 *
 * That is not a convenience. `order_items.quantity = N ⇒ N registrations` is a
 * cross-row invariant, and there is no transaction here to enforce it across
 * two calls (see the paragraph above: PostgREST gives one statement per round
 * trip). Splitting it would mean a window where the seats are taken and nobody
 * knows who is sitting in them — and orders created inside that window would
 * survive it. Migration 0020 §2 works through why a deferred constraint trigger
 * cannot express this either.
 *
 * It is still one call per booking line, so an order with two sittings is two
 * calls and the second can fail after the first succeeded. The undo is now
 * release_session_seat(order_item_id), whose DELETE … RETURNING is its own
 * idempotent claim — strictly better than the read/compare-and-swap/retry loop
 * this file used to run, and it gives the attendee rows back along with the
 * seats.
 *
 * ⚠️ The order inside the catch block is load-bearing: release BEFORE delete.
 *    event_registrations cascades from order_items, which cascades from orders,
 *    so deleting the order first would take the attendee rows away while
 *    event_sessions.seats_taken kept counting them. Nothing would ever notice.
 *
 * Step 5 is also the only place a browser-supplied id points at a row other
 * than the product it is paying for: `sessionId`. reserve_session_seat() step ③
 * refuses a session whose product is not this line's product, and refuses an
 * order_item that belongs to another order. Do not remove that check on the
 * grounds that this file "already knows" — this file is exactly what a tampered
 * payload is trying to talk its way past.
 *
 * Step 7 is outside that scheme on purpose: it happens after the order is
 * durable, and its only writes (the payments audit row and orders.payment_url)
 * are records, not state. If it fails, the order still exists and the shopper
 * can pay again from the confirmation page — which is strictly better than
 * deleting an order whose stock has already been deducted.
 *
 * ⚠️ STEP 7 CHANGED SHAPE：它以前是「記錄付款意圖並組出 PayUni 表單」，現在是
 *    「記錄付款意圖並向**黑貓 PAY（統一客樂得 COCS）**建單，取回線上刷卡網址」。
 *    這家店的商店帳號是黑貓 PAY，PayUni 只是它的收單銀行（acquirer_type），
 *    見 src/server/blackcat.ts 的檔頭。PayUni 直連那條路整支保留成 fallback
 *    （buildPayuniHandoff），一行沒改。
 *
 *    這個改變讓 step 7 從「純本地計算」變成「一次對外的網路呼叫」，所以它現在
 *    **會慢、會逾時、會失敗**。位置沒有跟著改，理由與原本完全相同、而且更重要了：
 *    它在訂單 durable 之後，失敗只是拿不到付款網址 —— 訂單與庫存都還在，客人可以
 *    從確認頁再按一次。把它往前挪到訂單建立之前，才會變成「黑貓慢一秒 = 客人的
 *    庫存與座位全部白扣一次」。
 *
 * Net effect: a failed checkout leaves **no** orders row, hence no order_items
 * and no order_addresses, and leaves stock and seats where they were.
 *
 * WHAT HAPPENS TO THE STOCK IF NOBODY EVER PAYS
 * ---------------------------------------------
 * Stock and seats are taken here, at order time, before a single dollar has
 * moved — so an abandoned payment page holds inventory that nobody can buy.
 * Giving it back is NOT this file's job and must not be added to it: it is
 * public.expire_unpaid_orders() (0006, extended by 0011 to drop the inventory
 * reservations too), which cancels and restores in one transaction. This file
 * only ever takes.
 *
 * WHAT TURNS A RESERVATION INTO A SALE
 * ------------------------------------
 * Nothing in the checkout does. commitInventoryForOrder() below is called from
 * the PayUni webhook once the money is confirmed, and it is the only place an
 * inv.sales row is ever written on behalf of the website.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";
import {
  CheckoutError,
  computeShippingFee,
  type CheckoutPayload,
  type OrderConfirmation,
  type PaymentHandoff,
  type ProductTypeForOrder,
  type ShippingMethod,
} from "@/lib/checkout";
import { normalizeInvoiceChoice } from "@/lib/invoice-format";

/** Columns checkout needs from public.products. Price is re-read, never trusted. */
const PRODUCT_COLUMNS =
  "id, product_type, title, price, stock, capacity, seats_taken, requires_shipping, status";

type ProductRow = {
  id: string;
  product_type: ProductTypeForOrder;
  title: Localized;
  price: number;
  stock: number | null;
  /**
   * ⚠️ 0020 之後這兩欄一律是 null / 0（`products_capacity_moved_to_sessions`）。
   *    留在 PRODUCT_COLUMNS 裡是為了讓這支查詢在 migration 套用前後都成立 ——
   *    程式碼先上線、migration 後套用，中間那段時間欄位還帶著舊值。名額真正的
   *    來源是 public.event_sessions，見 SESSION_COLUMNS。
   */
  capacity: number | null;
  seats_taken: number;
  requires_shipping: boolean;
  status: string;
};

/** 名額的真相在這張表（0020）。 */
const SESSION_COLUMNS = "id, product_id, capacity, seats_taken, status";

type SessionRow = {
  id: string;
  product_id: string;
  capacity: number;
  seats_taken: number;
  status: string;
};

/** 一位參加者，如同瀏覽器被允許描述的樣子。沒有任何金額欄位。 */
type ParticipantInput = {
  name: string;
  email?: string | null;
  phone?: string | null;
  noticeAck?: boolean;
};

/** A line after the server has priced it. Nothing here came from the browser except `quantity`. */
type PricedLine = {
  productId: string;
  /**
   * The sitting this line books, or null for goods/book. Taken from the
   * payload and then **verified against the database** — priceLines() refuses a
   * booking whose sessionId is missing, closed, or belongs to another product,
   * and refuses a non-booking that carries one at all.
   *
   * That check is repeated inside reserve_session_seat() (step ③) on purpose.
   * This one gives the shopper a clean rejection before an order number is
   * burned; that one is the guard that holds the row lock.
   */
  sessionId: string | null;
  /**
   * Who is coming, in the order the shopper typed them. Exactly `quantity`
   * entries for a booking, empty for everything else.
   *
   * ⚠️ PII. It exists inside this function call and inside the SQL statement
   *    that writes it, and nowhere else — it is never logged, never returned to
   *    the browser, and never written to any table but event_registrations.
   */
  participants: ParticipantInput[];
  productType: ProductTypeForOrder;
  name: Localized;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  requiresShipping: boolean;
  /**
   * `products.stock is not null` — i.e. this line is counted by public.products
   * itself and therefore belongs to atomic_deduct_stock().
   *
   * A NULL stock means one of two things, and neither may be sent to
   * atomic_deduct_stock(): the product is not stock-managed at all, or its
   * stock lives in the inventory system (0011 forbids a linked product from
   * also carrying a catalog stock number, precisely so these two numbers can
   * never disagree). atomic_deduct_stock() cannot tell either case apart from
   * a shortfall — it would raise INSUFFICIENT_STOCK on a product that is in
   * fact available — so the filtering has to happen here.
   */
  stockManaged: boolean;
};

export type PlacedOrder = {
  orderNo: string;
  /** Unguessable lookup key. Returned exactly once, here — never by a status read. */
  publicToken: string;
  total: number;
  /**
   * The PayUni form the browser has to POST, or null when this order is not
   * going to a gateway at all. See PaymentHandoff for why it is a form.
   */
  payment: PaymentHandoff | null;
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
  // ⚠️ Merged on (product, sitting), not on product alone. Before 0020 the key
  // was the product id, because two lines for the same product really were
  // indistinguishable. They are not any more: one activity with a morning and
  // an evening sitting is two different things to buy, and merging them would
  // charge for both while seating everyone in whichever one came first.
  const wanted = new Map<
    string,
    { productId: string; sessionId: string | null; quantity: number; participants: ParticipantInput[] }
  >();
  for (const item of items) {
    const sessionId = item.sessionId ?? null;
    const key = `${item.productId}:${sessionId ?? ""}`;
    const existing = wanted.get(key);
    if (existing) {
      existing.quantity += item.quantity;
      existing.participants = existing.participants.concat(item.participants ?? []);
    } else {
      wanted.set(key, {
        productId: item.productId,
        sessionId,
        quantity: item.quantity,
        participants: [...(item.participants ?? [])],
      });
    }
  }
  if (wanted.size === 0) throw new CheckoutError("cart_empty");

  const productIds = [...new Set([...wanted.values()].map((w) => w.productId))];
  const { data, error } = await supabaseAdmin()
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("status", "active")
    .in("id", productIds);

  if (error) throw new CheckoutError("order_failed");

  const rows = (data ?? []) as unknown as ProductRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  // The sittings this cart claims to be booking, read back from the database.
  // Only queried when the cart actually holds a booking, so an all-books
  // checkout costs exactly the round trips it did before 0020.
  const sessionIds = [
    ...new Set([...wanted.values()].map((w) => w.sessionId).filter((id): id is string => id !== null)),
  ];
  const sessionById = new Map<string, SessionRow>();
  if (sessionIds.length > 0) {
    const { data: sessionRows, error: sessionError } = await supabaseAdmin()
      .from("event_sessions")
      .select(SESSION_COLUMNS)
      .in("id", sessionIds);
    if (sessionError) throw new CheckoutError("order_failed");
    for (const row of (sessionRows ?? []) as unknown as SessionRow[]) {
      sessionById.set(row.id, row);
    }
  }

  // Every requested id must still be on sale. Reporting the whole cart as
  // unavailable rather than silently dropping the line is deliberate: dropping
  // it would charge the shopper for an order they did not agree to.
  const lines: PricedLine[] = [];
  for (const w of wanted.values()) {
    const p = byId.get(w.productId);
    if (!p) throw new CheckoutError("product_unavailable");

    // ---- the shape rules order_items' CHECK will enforce anyway -----------
    // Checked here first so the shopper gets a sentence instead of a 23514.
    if (isBooking(p.product_type)) {
      if (w.sessionId === null) throw new CheckoutError("product_unavailable");
      const session = sessionById.get(w.sessionId);
      // Missing, closed, or belonging to a different product — all three mean
      // "you cannot book this", and all three are reported the same way. Being
      // more specific here would turn the checkout into an oracle that tells a
      // prober which session ids exist.
      if (!session || session.status !== "open" || session.product_id !== p.id) {
        throw new CheckoutError("product_unavailable");
      }
      if (w.participants.length !== w.quantity) throw new CheckoutError("order_failed");
      for (const person of w.participants) {
        const hasName = person.name.trim().length > 0;
        const hasContact =
          (person.email ?? "").trim().length > 0 || (person.phone ?? "").trim().length > 0;
        if (!hasName || !hasContact) throw new CheckoutError("order_failed");
      }
    } else if (w.sessionId !== null || w.participants.length > 0) {
      // A book with a sitting attached is a payload that has been edited.
      throw new CheckoutError("product_unavailable");
    }

    lines.push({
      productId: p.id,
      sessionId: w.sessionId,
      participants: w.participants,
      productType: p.product_type,
      name: p.title,
      unitPrice: p.price,
      quantity: w.quantity,
      subtotal: p.price * w.quantity,
      requiresShipping: p.requires_shipping,
      stockManaged: p.stock !== null,
    });
  }

  // A product whose stock lives in the inventory system has products.stock =
  // NULL, so the loop below cannot see a shortfall for it. public.product_availability
  // is the one read that answers "how many of these can actually be sold", and
  // it answers it for linked and unlinked products alike (0011 §12).
  //
  // Capped at 10 by design, so this only rejects small carts with certainty;
  // a cart of 15 against 12 units passes here and is caught by step 6a. That is
  // the same bargain the rest of this function makes — see below.
  const needsAvailability = lines.some((l) => !isBooking(l.productType) && !l.stockManaged);
  const available = new Map<string, number>();
  if (needsAvailability) {
    const { data: availRows } = await supabaseAdmin()
      .from("product_availability")
      .select("product_id, available_capped")
      .in("product_id", productIds);
    for (const row of (availRows ?? []) as unknown as {
      product_id: string;
      available_capped: number;
    }[]) {
      available.set(row.product_id, row.available_capped);
    }
  }

  // Cheap, write-free rejection of the common cases, so an ordinary "sold out"
  // never burns an order number. It is NOT the real guard — steps 5, 6a and 6b
  // are, and they still have to handle the racing shopper this check cannot see.
  for (const line of lines) {
    const p = byId.get(line.productId)!;
    if (isBooking(p.product_type)) {
      // ⚠️ Reads event_sessions, NOT products.capacity/seats_taken. After 0020
      // those two are pinned to null/0 by a CHECK, so the old condition
      // (`p.capacity !== null && …`) is false for every row — it would wave
      // every booking through, which is the fail-OPEN direction.
      const session = sessionById.get(line.sessionId!)!;
      if (session.seats_taken + line.quantity > session.capacity) {
        throw new CheckoutError("no_seats_left");
      }
    } else if (line.stockManaged) {
      if (p.stock !== null && p.stock < line.quantity) {
        throw new CheckoutError("insufficient_stock");
      }
    } else if (available.has(line.productId)) {
      // `Math.min(…, 10)` is what makes the cap harmless rather than a false
      // rejection: asking for 20 against a capped 10 must not fail here.
      if (available.get(line.productId)! < Math.min(line.quantity, 10)) {
        throw new CheckoutError("insufficient_stock");
      }
    }
  }

  return lines;
}

// -----------------------------------------------------------------------------
// Seat rollback
// -----------------------------------------------------------------------------

/**
 * Give back the seats — and the attendee rows — claimed by
 * reserve_session_seat() when a later step failed.
 *
 * One RPC per order item. `release_session_seat()` deletes this item's
 * event_registrations with DELETE … RETURNING and subtracts exactly the number
 * of rows it actually removed, all under the session's row lock. That makes it
 * its own idempotent claim: calling it twice gives back the seats once, and the
 * second call reports 0.
 *
 * ⚠️ This replaced a read / compare-and-swap / retry-three-times loop against
 *    products.seats_taken. Do not reintroduce anything of that shape here.
 *    PostgREST can only send an absolute value for a PATCH, which is why that
 *    loop existed at all; doing the arithmetic inside the function removes the
 *    read-modify-write entirely rather than making it survivable.
 *
 * Best effort by design, on both sides: this runs while another error is
 * already being reported, so it must never throw and mask it, and the SQL
 * function has its own `exception when others then return 0`. The worst case is
 * a seat that stays counted until someone looks, which is far better than a
 * seat sold twice.
 */
async function releaseSeats(orderItemIds: number[]): Promise<void> {
  const db = supabaseAdmin();
  for (const orderItemId of orderItemIds) {
    try {
      const { error } = await db.rpc("release_session_seat", { p_order_item_id: orderItemId });
      if (error) {
        // ⚠️ code + message only, never the whole error object. PostgREST
        // forwards Postgres's `DETAIL: Failing row contains (…)`, and for
        // event_registrations that row is somebody's name and phone number.
        // Logging the object would put attendee PII in the Vercel log.
        console.error(`[seats] release 失敗 item=${orderItemId}: ${error.code} ${error.message}`);
      }
    } catch {
      /* best effort — see the doc comment */
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

/**
 * Undo step 6a. Best effort, same contract as releaseSeats(): it runs while
 * another error is already being reported and must never throw over it.
 *
 * Nothing is added back — the physical stock_quantity was never reduced. All
 * this does is delete the hold, which is the whole point of the reservation
 * design (0011 §8).
 */
async function releaseInventoryReservations(orderId: string | null): Promise<void> {
  if (!orderId) return;
  try {
    await supabaseAdmin().rpc("release_inventory_reservations", { p_order_id: orderId });
  } catch {
    /* best effort — see releaseSeats() */
  }
}

/**
 * Turn this order's reservations into real inventory sales. Called by the
 * PayUni webhook, and ONLY after the payment is confirmed and the order row
 * already says paid.
 *
 * ⚠️ Never call this from the checkout path. Before the money has moved, an
 * inv.sales row is a fabricated sale: it pollutes revenue reports, gets picked
 * up by inv.allocate_fifo_cost(), and lands in supplier reconciliation — and
 * then has to be deleted 30 minutes later.
 *
 * Returns the number of oversold alerts written (0 is the normal case, and also
 * what a re-delivered webhook gets, because the underlying function claims its
 * work with DELETE … RETURNING). Never throws: by the time this runs the
 * customer has paid, and there is no failure here worth turning into a 5xx that
 * would make PayUni redeliver forever.
 */
export async function commitInventoryForOrder(orderId: string): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin().rpc("commit_inventory_reservations", {
      p_order_id: orderId,
      p_staff_user_id: null,
    });
    if (error) {
      console.error(`[inventory] commit 失敗 order=${orderId}:`, error.message);
      return 0;
    }
    const oversold = typeof data === "number" ? data : 0;
    if (oversold > 0) {
      console.error(
        `[inventory] order=${orderId} 有 ${oversold} 個品項庫存不足仍已出貨 —— 已寫入 stock_oversold_alerts,需人工處理`,
      );
    }
    return oversold;
  } catch (err) {
    // 訊息字串，不是整包物件 —— 同 releaseSeats() 的理由：supabase-js 把
    // PostgREST 的 `DETAIL: Failing row contains (…)` 掛在 error 物件上，而這條
    // 路徑跑在有 order_items 的交易之後，那個 DETAIL 可能帶著訂單內容。
    console.error(
      `[inventory] commit 例外 order=${orderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
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

/** 兩支 hand-off builder 共用的最小訂單形狀。 */
type PayableOrder = {
  id: string;
  order_no: string;
  public_token: string;
  total: number;
};

/**
 * 建立黑貓 PAY（統一客樂得 COCS）的付款交接 —— **這是實際在跑的那一條**。
 *
 * 與 PayUni 那一支最大的不同：這裡會**真的對外打一次 API**（CocsOrderAppend，
 * 規格 V1.28.2 P40），訂單在伺服器端就建出來了，回來的是一個線上刷卡網址。
 * PayUni 是純本地組表單，交易要等瀏覽器 POST 才存在。
 *
 * ⚠️ success_url 必須在**建單當下**就把 public_token 組進去（blackcatReturnUrl）。
 *    金流商導回時只會帶它自己的參數，token 沒有先組進去，確認頁就沒有東西可以
 *    把訂單找回來。
 *
 * ⚠️ apn_url 也在這裡帶上，而且帶的是含 ?k=<BLACKCAT_WEBHOOK_SECRET> 的那一版 ——
 *    那是 APN handler 的第一道閘門（見 blackcat-webhook.ts）。
 *
 * ⚠️ 付款網址寫進 orders.payment_url（0024）。用意是「重新付款」不必再跟黑貓建
 *    第二次單，以及後台看得到這張訂單當初被送去哪裡。寫失敗只 log 不中斷 ——
 *    客人手上已經有網址了，少一筆稽核不值得讓結帳失敗。
 *
 * ⚠️ recordPaymentIntent 在建單**之前**呼叫。順序是刻意的：payments 的唯一索引
 *    (gateway, gateway_tx_id) 是「一個訂單一個金流一筆交易」的資料庫保證，先寫
 *    才能讓「建單成功但我們沒記到」這個對不上帳的情況不存在。它自己吞掉 23505。
 *
 * 未設定完成時回 null 而不是 throw：沒有憑證的部署必須降級成「不經金流」
 * （訂單留著、由店家另行安排付款），絕不可以降級成「結帳失敗」。
 */
async function buildBlackcatHandoff(order: PayableOrder): Promise<PaymentHandoff | null> {
  const { blackcatApnUrl, blackcatConfigured, blackcatReturnUrl, createCocsOrder } =
    await import("@/server/blackcat");
  if (!blackcatConfigured()) return null;

  const apnUrl = blackcatApnUrl();
  if (!apnUrl) {
    // blackcatConfigured() 已經包含這個檢查，走到這裡代表兩者不同步了。
    console.error("[checkout] 黑貓 PAY 的 APN 網址組不出來，退回其他金流");
    return null;
  }

  try {
    const { recordPaymentIntent } = await import("@/server/repos/payments");
    await recordPaymentIntent(order, "blackcat");

    const created = await createCocsOrder({
      orderNo: order.order_no,
      amount: order.total,
      detail: `小時光書店訂單 ${order.order_no}`,
      apnUrl,
      successUrl: blackcatReturnUrl(order.public_token),
    });
    if (!created.ok) {
      // ⚠️ 只印對方給的錯誤訊息，不印整包回應 —— 金流回應含卡號後四碼與授權碼。
      console.error(`[checkout] 黑貓 PAY 建單失敗 order=${order.order_no}: ${created.reason}`);
      return null;
    }

    const { error } = await supabaseAdmin()
      .from("orders")
      .update({ payment_url: created.url })
      .eq("id", order.id);
    // ⚠️ 只印訊息，**不可以**把 Supabase 的 error 物件整包丟進去 —— 它會把
    //    被拒絕的那一列原樣回吐，而 orders 那一列滿是客人的個資。
    //    scripts/event-registration-selftest.mjs [12] 會掃這個檔案抓這種寫法。
    if (error) {
      console.error(`[checkout] payment_url 寫入失敗 order=${order.order_no}: ${error.message}`);
    }

    return { kind: "redirect", url: created.url };
  } catch (err) {
    console.error(
      `[checkout] buildBlackcatHandoff failed order=${order.order_no}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Builds the PayUni hand-off for an order that still needs paying.
 *
 * ⚠️ **這條路現在是 fallback，不是主線。** 這家店的商店帳號是黑貓 PAY（COCS），
 *    PayUni 只是它的收單銀行；PayUni 直連 UPP 沒有憑證，payuniConfigured() 會是
 *    false，所以實務上這一支會直接回 null。整支保留不動是為了哪天真的開直連。
 *
 * Shared by createOrder (first attempt) and the "pay again" path, so the two
 * cannot drift: both send the same MerTradeNo (= order_no) and the same
 * ReturnURL, which is what lets the webhook match a notification back to an
 * order by a single column.
 *
 * ⚠️ The ReturnURL has to be built here, at order time, carrying public_token.
 * The gateway sends back only its own parameters, so if the token is not baked
 * into the URL now there is nothing on the confirmation page to look the order
 * up with.
 *
 * Returns null rather than throwing when PayUni is not configured: an
 * unconfigured gateway must degrade to the pre-gateway behaviour (order held,
 * payment arranged by hand), never to a failed checkout.
 */
async function buildPayuniHandoff(order: {
  id: string;
  order_no: string;
  public_token: string;
  total: number;
}): Promise<PaymentHandoff | null> {
  const { buildUppForm, payuniConfigured, payuniReturnUrl } = await import("@/server/payuni");
  if (!payuniConfigured()) {
    console.warn("[checkout] PayUni 未設定完成,退回「不經金流」流程");
    return null;
  }
  try {
    const { action, fields } = buildUppForm({
      merTradeNo: order.order_no,
      amount: order.total,
      prodDesc: `小時光書店訂單 ${order.order_no}`,
      returnUrl: payuniReturnUrl(order.public_token),
    });
    const { recordPaymentIntent } = await import("@/server/repos/payments");
    await recordPaymentIntent(order, "payuni");
    return { kind: "form", action, fields };
  } catch (err) {
    console.error(
      `[checkout] buildPayuniHandoff failed order=${order.order_no}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * 刷卡交接的**唯一入口**。三個呼叫端（首次結帳、idempotency 重播、重新付款）
 * 都走這裡，所以「哪一個金流在跑」這件事只在這一個地方決定。
 *
 * 順序就是優先序：**黑貓 PAY 優先**（這家店實際簽的帳號），退回 PayUni 直連
 * （留著但沒有憑證），兩者都沒有就回 null —— 那是「不經金流」的既有降級路徑，
 * 訂單成立、庫存扣好、由店家另行安排付款，與這家店在有金流之前的行為一致。
 *
 * ⚠️ 不要在呼叫端各自判斷金流。三個呼叫端各判一次，就是三個會慢慢長歪的地方。
 */
async function buildCardHandoff(order: PayableOrder): Promise<PaymentHandoff | null> {
  const blackcat = await buildBlackcatHandoff(order);
  if (blackcat) return blackcat;

  const payuni = await buildPayuniHandoff(order);
  if (payuni) return payuni;

  console.warn(`[checkout] 沒有可用的金流 order=${order.order_no}，退回「不經金流」流程`);
  return null;
}

/**
 * Re-issues the gateway hand-off for an order that was created but never paid.
 *
 * Keyed on public_token for the same reason the confirmation read is: order_no
 * is sequential and guessable, and this returns a live payment form.
 *
 * The same MerTradeNo is deliberately reused — this is the *same* trade being
 * attempted again, not a new one, and reusing it keeps webhook matching and the
 * unique payments row intact.
 * TODO(憑證實測): PayUni 文件寫「MerTradeNo 10 分鐘內不可重複」。那條規則是針對
 * 不同交易;同一筆未完成交易重送應為正常重試路徑,但沒有商店憑證無法實測確認。
 * 若沙盒回「訂單重複」,改成 `${order_no}-R<n>` 並把 payments.gateway_tx_id 一起更新。
 */
export async function reissuePayment(token: string): Promise<PaymentHandoff | null> {
  const { data } = await supabaseAdmin()
    .from("orders")
    .select("id, order_no, public_token, total, status, payment_status")
    .eq("public_token", token)
    .maybeSingle();
  if (!data) return null;

  const order = data as unknown as {
    id: string;
    order_no: string;
    public_token: string;
    total: number;
    status: string;
    payment_status: string;
  };

  // Only an order that is still waiting may be paid. A paid, cancelled or
  // shipped order must never be handed a live payment form.
  if (order.status !== "pending" || order.payment_status === "paid") return null;

  return buildCardHandoff(order);
}

/**
 * Creates a pending, unpaid order.
 *
 * `status` and `payment_status` are both left at their 'pending' defaults:
 * an order here means "we have your details and your stock is held", not "you
 * have paid". Nothing in this file may ever set payment_status = 'paid'; that
 * belongs to src/server/repos/payments.ts, reached only from the webhook, which
 * is the only party that knows.
 *
 * `payment_method` is written at order time only for the card path, so that
 * "this order was sent to a gateway" is visible in the row itself rather than
 * having to be inferred from the payments table.
 */
export async function createOrder(payload: CheckoutPayload): Promise<PlacedOrder> {
  const db = supabaseAdmin();
  const wantsCard = payload.paymentMethod === "card";

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
      // NULL for the offline path — orders.payment_method's CHECK has no
      // 'offline' value, and NULL is exactly what "no gateway involved" means.
      payment_method: wantsCard ? "card" : null,
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
  /** order_items ids whose seats have been taken and must be given back on failure. */
  const reservedItemIds: number[] = [];
  let reservedInventory = false;

  try {
    // ---- step 3: order_items ------------------------------------------------
    // Built by one mapper so every object carries an identical key set.
    // PostgREST rejects a batch whose objects differ ("All object keys must
    // match") — adding, say, product_id to only the rows that have one turns
    // the whole insert into a 400.
    //
    // ⚠️ Two rules govern the shape of these objects and they pull in opposite
    //    directions:
    //
    //    1. Every object in the batch must carry an IDENTICAL key set.
    //       PostgREST rejects a mixed batch with "All object keys must match",
    //       so `session_id` cannot be present on only the booking rows.
    //
    //    2. `order_items.session_id` does not exist until migration 0020 is
    //       applied — and this code ships BEFORE the migration does. Sending
    //       the column unconditionally would 400 every book checkout in the
    //       window between the deploy and the migration. (Verified: PostgREST
    //       answers `column "session_id" of relation "order_items" does not
    //       exist`, and there is nothing about a cart of books that should care
    //       whether sittings exist yet.)
    //
    //    Both are satisfied by deciding ONCE per order: a cart with no booking
    //    in it omits the column entirely — which is also exactly what it means
    //    — and a cart with one carries it on every row, null on the books. A
    //    cart with a booking cannot exist before 0020 anyway: there is no way
    //    to create a sitting until the table does.
    //
    // The ids come back because step 5 needs them: reserve_session_seat() keys
    // the attendee rows on order_item_id, which does not exist until this
    // insert has run.
    const anySession = lines.some((l) => l.sessionId !== null);
    const { data: insertedItems, error: itemsError } = await db
      .from("order_items")
      .insert(
        lines.map((l) => {
          const row: Record<string, unknown> = {
            order_id: order.id,
            product_id: l.productId,
            name: l.name,
            unit_price: l.unitPrice,
            quantity: l.quantity,
            subtotal: l.subtotal,
            product_type: l.productType,
          };
          if (anySession) row.session_id = l.sessionId;
          return row;
        }),
      )
      .select(anySession ? "id, product_id, session_id" : "id, product_id");
    if (itemsError || !insertedItems) throw new CheckoutError("order_failed");

    // Matched by (product, sitting) rather than by array position: priceLines()
    // already merged duplicates on exactly that key, so it is unique per order,
    // and relying on PostgREST returning rows in insertion order would be an
    // assumption nothing in its contract makes.
    const itemIdByKey = new Map<string, number>();
    for (const row of insertedItems as unknown as {
      id: number;
      product_id: string | null;
      session_id?: string | null;
    }[]) {
      itemIdByKey.set(`${row.product_id ?? ""}:${row.session_id ?? ""}`, row.id);
    }

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

    // ---- step 4b: invoices (發票開法) ---------------------------------------
    // 客人在結帳時選的開法。寫在這裡而不是等開票時再問，理由有兩個：
    //
    //   * 開票是**付款成功之後**才發生的（webhook → invoice-issuer），那時候客人
    //     早就離開表單了。這一列是唯一一次能問到「這張發票要開給誰」的機會。
    //   * 0007 的 claim_invoice_issue() 會在缺列時補一列預設值（personal / 無載具）。
    //     所以沒有這一步不會壞掉 —— 它只是會**一律開 B2C 個人發票**，公司戶永遠拿不
    //     到可以報帳的發票，而且沒有任何錯誤訊息會說出這件事。
    //
    // 放在 try 裡（步驟 2–4 的可回復區間內）是刻意的：發票開錯抬頭要作廢重開，而作廢
    // 重開的成本比「這次結帳失敗、請再試一次」高得多。寧可整筆退回。
    //
    // ⚠️ normalizeInvoiceChoice() 的回傳只有六個欄位，沒有一個是金額。發票欄位不參與
    // 上面任何一行的計算 —— subtotal / shippingFee / total 在這一步之前就算完了，而且
    // 是從 public.products 算的。
    const invoice = normalizeInvoiceChoice(payload.invoice);
    const { error: invoiceError } = await db.from("invoices").insert({
      order_id: order.id,
      invoice_type: invoice.type,
      tax_id: invoice.taxId,
      company_title: invoice.companyTitle,
      carrier_type: invoice.carrierType,
      carrier_number: invoice.carrierNumber,
      love_code: invoice.loveCode,
    });
    if (invoiceError) throw new CheckoutError("order_failed");

    // ---- step 5: seats + attendees (ONE call, see the file header) ---------
    // Sorted by session id so two concurrent orders that book the same pair of
    // sittings take the row locks in the same order and cannot deadlock against
    // each other — the same reasoning atomic_deduct_stock() applies internally.
    // Sorting by product id (what this loop used to do) is not enough any more:
    // two sittings of the SAME product are two different rows to lock.
    for (const line of lines
      .filter((l) => isBooking(l.productType))
      .sort((a, b) => ((a.sessionId ?? "") < (b.sessionId ?? "") ? -1 : 1))) {
      const orderItemId = itemIdByKey.get(`${line.productId}:${line.sessionId ?? ""}`);
      if (orderItemId === undefined) throw new CheckoutError("order_failed");

      const { error } = await db.rpc("reserve_session_seat", {
        p_order_id: order.id,
        p_order_item_id: orderItemId,
        p_session_id: line.sessionId,
        p_quantity: line.quantity,
        p_participants: line.participants.map((person) => ({
          name: person.name.trim(),
          email: (person.email ?? "").trim() || null,
          phone: (person.phone ?? "").trim() || null,
          // The database stores a timestamp, not a flag — it takes now() when
          // this is true. See event_registrations.notice_ack_at.
          noticeAck: person.noticeAck === true ? "true" : "false",
        })),
      });

      if (error) {
        // ⚠️ code + message only. PostgREST forwards Postgres's
        // `DETAIL: Failing row contains (…)`, which for this statement is an
        // attendee's name and phone number. Logging `error` whole would write
        // that into the Vercel log; there is a static test asserting this line
        // does not.
        console.error(
          `[seats] reserve 失敗 order=${order.id} item=${orderItemId}: ${error.code} ${error.message}`,
        );
        // Only NO_SEATS_LEFT is something the shopper can act on ("pick fewer
        // places"). Everything else the function raises — a mismatched session,
        // a closed sitting, a participant count that does not match the
        // quantity — means the payload was edited or this file has a bug, and
        // neither is worth a specific sentence in the shop's three languages.
        throw new CheckoutError(
          (error.message ?? "").includes("NO_SEATS_LEFT") ? "no_seats_left" : "order_failed",
        );
      }
      reservedItemIds.push(orderItemId);
    }

    // ---- step 6a: inventory reservations (REVERSIBLE) ------------------------
    // Physical stock in inv.products is NOT touched here. This only writes rows
    // to stock_reservations, which is what makes the step undoable: releasing
    // is a delete, not a compensating write, so an abandoned cart leaves the
    // inventory system byte-for-byte as it was — no sales row, no stock move,
    // nothing for a report to pick up. See 0011's header for why writing
    // inv.sales at order time would be wrong.
    //
    // Products with no link row are skipped inside the function, so passing the
    // whole non-booking cart is safe and keeps the decision in one place.
    const invLines = lines.filter((l) => !isBooking(l.productType));
    if (invLines.length > 0) {
      const { error } = await db.rpc("reserve_inventory_stock", {
        p_order_id: order.id,
        p_items: invLines.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
      });
      if (error) throw new CheckoutError("insufficient_stock");
      reservedInventory = true;
    }

    // ---- step 6b: catalog stock (IRREVERSIBLE — must stay last) -------------
    // One call for every stock-managed line, so it is one transaction: either
    // the whole cart is deducted or none of it is. Never split this into a loop.
    //
    // Still the last step for the reason the header gives: nothing after it can
    // fail, so "restore the stock" remains a case that cannot arise. 6a sits in
    // front of it precisely because 6a *is* undoable.
    const stockLines = lines.filter((l) => !isBooking(l.productType) && l.stockManaged);
    if (stockLines.length > 0) {
      const { error } = await db.rpc("atomic_deduct_stock", {
        p_items: stockLines.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
      });
      if (error) throw new CheckoutError("insufficient_stock");
    }
  } catch (err) {
    // Order matters only in that all three are best-effort and none may throw.
    // The reservation release is also covered by `on delete cascade` from the
    // orders row, but doing it explicitly means the stock comes back even if
    // deleteOrder() is the thing that failed.
    // ⚠️ releaseSeats BEFORE deleteOrder, always. event_registrations cascades
    //    from order_items which cascades from orders, so deleting first would
    //    take the attendee rows away while event_sessions.seats_taken kept
    //    counting them — a seat held forever with nothing pointing at it.
    await releaseInventoryReservations(reservedInventory ? order.id : null);
    await releaseSeats(reservedItemIds);
    await deleteOrder(order.id);
    throw err instanceof CheckoutError ? err : new CheckoutError("order_failed");
  }

  // ---- step 7: payment hand-off ---------------------------------------------
  // After the order is durable, never before: if this throws we still want the
  // order to exist so the shopper can retry payment rather than lose the lot.
  const payment = wantsCard ? await buildCardHandoff(order) : null;

  return {
    orderNo: order.order_no,
    publicToken: order.public_token,
    total: order.total,
    payment,
  };
}

/**
 * Called both as the first thing createOrder does (the replay short-circuit)
 * and after a 23505 on idempotency_key, so "not found" here means the conflict
 * was on some other unique column and the caller should report a plain failure
 * rather than invent a success.
 *
 * A replay rebuilds the gateway form rather than returning null for it: the
 * double-clicked submit that produced the replay is exactly the case where the
 * shopper is still sitting there waiting to be sent to PayUni.
 */
async function findByIdempotencyKey(key: string): Promise<PlacedOrder | null> {
  const { data } = await supabaseAdmin()
    .from("orders")
    .select("id, order_no, public_token, total, status, payment_status, payment_method")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as {
    id: string;
    order_no: string;
    public_token: string;
    total: number;
    status: string;
    payment_status: string;
    payment_method: string | null;
  };

  const stillOwed = row.status === "pending" && row.payment_status !== "paid";
  const payment = row.payment_method === "card" && stillOwed ? await buildCardHandoff(row) : null;

  return {
    orderNo: row.order_no,
    publicToken: row.public_token,
    total: row.total,
    payment,
  };
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
      "id, order_no, status, payment_status, payment_method, subtotal, shipping_fee, discount, total, shipping_method, created_at",
    )
    .eq("public_token", token)
    .maybeSingle();
  if (error || !data) return null;

  const o = data as unknown as {
    id: string;
    order_no: string;
    status: string;
    payment_status: string;
    payment_method: string | null;
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
    paymentMethod: o.payment_method,
    /**
     * "A gateway owes us an answer about this order."
     *
     * Computed here, from the row, rather than in the browser from a URL
     * parameter — the gateway controls what it appends to the return URL, and
     * this value decides whether the cart is thrown away. `pending` covers the
     * shopper who is still on PayUni's page; `failed` covers the one who came
     * back after a declined card and may retry. Both must keep their cart.
     */
    awaitingPayment:
      o.payment_method !== null &&
      o.status === "pending" &&
      (o.payment_status === "pending" || o.payment_status === "failed"),
    subtotal: o.subtotal,
    shippingFee: o.shipping_fee,
    discount: o.discount,
    total: o.total,
    shippingMethod: o.shipping_method,
    createdAt: o.created_at,
    items,
  };
}
