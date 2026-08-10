/**
 * Data layer for payments / webhook_events — the only place the payment state
 * machine is allowed to move.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR
 * --------------------------------
 * src/server/repos/orders.ts creates orders and never sets payment_status.
 * This file is the counterpart: it is reached only from the PayUni webhook
 * (src/server/payuni-webhook.ts) and from the "pay again" server function, and
 * it is the only module that may write orders.payment_status / orders.paid_at.
 *
 * THE FOUR RULES THIS FILE EXISTS TO ENFORCE
 * ------------------------------------------
 *   1. **Signature first, database second.** Nothing here runs until
 *      verifyHashInfo() has passed in the caller. This module assumes the
 *      payload is authentic and concerns itself only with concurrency.
 *
 *   2. **Duplicate deliveries must not double-act.** claimWebhookEvent()
 *      inserts into public.webhook_events, whose `unique (gateway, event_key)`
 *      IS the lock — the same trick 0005 documents for
 *      order_post_payment_log. A second delivery of the same event loses the
 *      insert and is acked without doing anything. Because a claim taken and
 *      then lost to a crash would suppress a legitimate retry forever,
 *      releaseWebhookClaim() gives it back on any *retryable* failure.
 *
 *   3. **A late callback must never overwrite a newer state.** Every write is
 *      a compare-and-swap on the state we expect to still be in, never a blind
 *      `set payment_status = …`. Realreal shipped the blind version and had a
 *      delayed "failed" callback stomp an order that had already been paid and
 *      shipped. If the CAS matches nothing, we re-read and classify rather
 *      than retry.
 *
 *   4. **Money is compared, never assumed.** The amount the gateway says it
 *      collected is checked against orders.total before anything is marked
 *      paid, and a mismatch is a loud, recorded refusal — not a silent accept.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

/** Postgres unique-violation. A claim that loses this race is a duplicate, not an error. */
const UNIQUE_VIOLATION = "23505";

export type PaymentOrderRow = {
  id: string;
  order_no: string;
  public_token: string;
  total: number;
  status: string;
  payment_status: string;
  paid_at: string | null;
};

const ORDER_COLUMNS = "id, order_no, public_token, total, status, payment_status, paid_at";

/**
 * Orders that have moved past "waiting to be paid". A callback arriving about
 * one of these is late by definition and must not rewrite it.
 *
 * `cancelled` is in here deliberately: once the 0006 sweeper has given the
 * stock back, quietly flipping the order to paid would sell inventory that has
 * already been returned to the shelf. That case gets an alert instead.
 */
const TERMINAL_STATUSES = new Set(["processing", "shipped", "completed", "cancelled", "failed"]);

// -----------------------------------------------------------------------------
// Lookup
// -----------------------------------------------------------------------------

/**
 * Finds the order a gateway notification is about.
 *
 * Keyed on order_no because that is what we send as MerTradeNo and what
 * payments.gateway_tx_id stores, so all three agree by construction.
 */
export async function findOrderByOrderNo(orderNo: string): Promise<PaymentOrderRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("order_no", orderNo)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as PaymentOrderRow;
}

export async function findOrderByPublicToken(token: string): Promise<PaymentOrderRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("public_token", token)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as PaymentOrderRow;
}

// -----------------------------------------------------------------------------
// payments row
// -----------------------------------------------------------------------------

/**
 * Records that we are about to send this order to PayUni.
 *
 * gateway_tx_id is set to order_no — the same string we send as MerTradeNo —
 * so the unique index payments_gateway_tx_idx makes "one live PayUni
 * transaction per order" a database fact rather than a convention. A retry of
 * the same order therefore hits 23505 and is treated as "already recorded",
 * which is correct: the shopper is being sent to the same trade number again.
 */
export async function recordPaymentIntent(order: {
  id: string;
  order_no: string;
  total: number;
}): Promise<void> {
  const { error } = await supabaseAdmin().from("payments").insert({
    order_id: order.id,
    gateway: "payuni",
    gateway_tx_id: order.order_no,
    status: "pending",
    amount: order.total,
  });
  if (error && error.code !== UNIQUE_VIOLATION) {
    // Not fatal to the checkout: the order exists and the shopper can still
    // pay. Losing the audit row is worth a log, not a failed purchase.
    console.error("[payments] recordPaymentIntent failed", error);
  }
}

async function updatePaymentRow(
  orderNo: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("payments")
    .update(patch)
    .eq("gateway", "payuni")
    .eq("gateway_tx_id", orderNo);
  if (error) console.error("[payments] updatePaymentRow failed", orderNo, error);
}

// -----------------------------------------------------------------------------
// webhook_events — the dedupe claim
// -----------------------------------------------------------------------------

export type ClaimResult = "claimed" | "duplicate" | "error";

/**
 * Takes the claim for one gateway event. The insert IS the lock.
 *
 * `event_key` must be derived only from fields the gateway will repeat
 * verbatim on a redelivery (see eventKeyFor). Anything that changes between
 * deliveries — a timestamp, a nonce — would defeat the whole mechanism by
 * making every redelivery look new.
 */
export async function claimWebhookEvent(
  eventKey: string,
  payload: Record<string, unknown>,
): Promise<ClaimResult> {
  const { error } = await supabaseAdmin()
    .from("webhook_events")
    .insert({ gateway: "payuni", event_key: eventKey, payload });
  if (!error) return "claimed";
  if (error.code === UNIQUE_VIOLATION) return "duplicate";
  console.error("[payments] claimWebhookEvent failed", eventKey, error);
  return "error";
}

/**
 * Gives a claim back after a *retryable* failure, so the gateway's next
 * delivery is processed instead of being mistaken for a duplicate.
 *
 * Only ever called on failures that a retry could fix (the database was
 * unreachable, the upstream query timed out). A refusal that will never
 * succeed — an amount mismatch — keeps its claim on purpose: retrying it
 * would just re-log the same alert forever.
 */
export async function releaseWebhookClaim(eventKey: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("webhook_events")
    .delete()
    .eq("gateway", "payuni")
    .eq("event_key", eventKey);
  if (error) console.error("[payments] releaseWebhookClaim failed", eventKey, error);
}

/** Records an event we refused to act on, for later reconciliation. */
export async function annotateWebhookEvent(
  eventKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("webhook_events")
    .update({ payload })
    .eq("gateway", "payuni")
    .eq("event_key", eventKey);
  if (error) console.error("[payments] annotateWebhookEvent failed", eventKey, error);
}

/**
 * The dedupe key for one PayUni notification.
 *
 * Built from (order, gateway transaction, resulting status): a redelivery of
 * the same result repeats all three, while a genuinely different event about
 * the same order — a later refund, a retry that finally succeeded — differs in
 * the last one and is allowed through.
 */
export function eventKeyFor(notify: Record<string, string>): string {
  const orderNo = notify.MerTradeNo ?? "-";
  const tradeNo = notify.TradeNo ?? "-";
  const status = notify.TradeStatus ?? "-";
  return `${orderNo}:${tradeNo}:${status}`;
}

// -----------------------------------------------------------------------------
// State transitions
// -----------------------------------------------------------------------------

export type MarkPaidResult =
  | { ok: true; changed: true }
  /** The order was already paid — a duplicate that got past the claim. Benign. */
  | { ok: true; changed: false; reason: "already_paid" }
  /**
   * Payment succeeded for an order that had already been cancelled (almost
   * always: the 0006 sweeper reclaimed the stock while the shopper was still
   * on the gateway's page). The money is real; the stock is gone. Needs a
   * human. Never resolved silently.
   */
  | { ok: false; reason: "paid_after_cancel" }
  | { ok: false; reason: "stale" }
  | { ok: false; reason: "db_error" };

/**
 * Moves an order to paid, once.
 *
 * The `eq` filters on status AND payment_status are the compare half of a
 * compare-and-swap: two concurrent deliveries both issue this UPDATE, exactly
 * one matches a row, and the loser falls through to the classification below
 * instead of writing a second time.
 */
export async function markOrderPaid(
  order: PaymentOrderRow,
  detail: { tradeNo?: string; amount: number; raw: Record<string, unknown> },
): Promise<MarkPaidResult> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("orders")
    .update({
      payment_status: "paid",
      status: "processing",
      payment_method: "card",
      paid_at: new Date().toISOString(),
    })
    .eq("id", order.id)
    .eq("status", "pending")
    .eq("payment_status", "pending")
    .select("id");

  if (error) {
    console.error("[payments] markOrderPaid update failed", order.order_no, error);
    return { ok: false, reason: "db_error" };
  }

  if (Array.isArray(data) && data.length > 0) {
    await updatePaymentRow(order.order_no, {
      status: "paid",
      amount: detail.amount,
      paid_at: new Date().toISOString(),
      raw_response: { ...detail.raw, tradeNo: detail.tradeNo ?? null },
    });
    return { ok: true, changed: true };
  }

  // The CAS matched nothing. Re-read rather than assume why.
  const fresh = await findOrderByOrderNo(order.order_no);
  if (!fresh) return { ok: false, reason: "db_error" };

  if (fresh.payment_status === "paid") {
    return { ok: true, changed: false, reason: "already_paid" };
  }
  if (fresh.status === "cancelled") {
    console.error(
      `[payuni] PAID AFTER CANCEL order=${order.order_no} amount=${detail.amount} — 款項已收但訂單已取消（庫存可能已回收），需人工對帳`,
    );
    await updatePaymentRow(order.order_no, {
      status: "paid",
      amount: detail.amount,
      paid_at: new Date().toISOString(),
      raw_response: { ...detail.raw, reconcile: "paid_after_cancel" },
    });
    return { ok: false, reason: "paid_after_cancel" };
  }
  // Some other state moved underneath us (manual admin action, a second
  // gateway). Leave it alone and say so.
  console.error(
    `[payuni] STALE PAID CALLBACK order=${order.order_no} status=${fresh.status} payment_status=${fresh.payment_status}`,
  );
  return { ok: false, reason: "stale" };
}

export type MarkFailedResult = "changed" | "ignored_terminal" | "db_error";

/**
 * Records a gateway failure/cancellation.
 *
 * Deliberately does NOT touch orders.status: the order stays `pending` so the
 * shopper can pay again from the confirmation page, and so the 0006 sweeper
 * still owns the decision about when to give the stock back. Only
 * payment_status moves, and only from 'pending'.
 */
export async function markPaymentFailed(
  order: PaymentOrderRow,
  detail: { reason: string; raw: Record<string, unknown> },
): Promise<MarkFailedResult> {
  // A late failure about an order that has already moved on is exactly the
  // Realreal bug. Short-circuit before writing anything.
  if (order.payment_status === "paid" || TERMINAL_STATUSES.has(order.status)) {
    console.warn(
      `[payuni] 忽略遲到的失敗通知 order=${order.order_no} status=${order.status} payment_status=${order.payment_status}`,
    );
    return "ignored_terminal";
  }

  const { data, error } = await supabaseAdmin()
    .from("orders")
    .update({ payment_status: "failed", failed_reason: detail.reason.slice(0, 200) })
    .eq("id", order.id)
    .eq("status", "pending")
    .eq("payment_status", "pending")
    .select("id");

  if (error) {
    console.error("[payments] markPaymentFailed update failed", order.order_no, error);
    return "db_error";
  }
  if (!Array.isArray(data) || data.length === 0) {
    console.warn(`[payuni] 失敗通知的 CAS 未命中（狀態已變動） order=${order.order_no}`);
    return "ignored_terminal";
  }

  await updatePaymentRow(order.order_no, {
    status: "failed",
    raw_response: detail.raw,
  });
  return "changed";
}
