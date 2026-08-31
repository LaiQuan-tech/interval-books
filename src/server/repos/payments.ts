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
 *
 * TWO GATEWAYS SHARE THIS FILE, AND `gateway` IS NEVER ALLOWED TO DEFAULT SILENTLY
 * -------------------------------------------------------------------------------
 * 黑貓 PAY（統一客樂得 COCS，src/server/blackcat.ts）是這家店**實際在跑**的那條
 * 刷卡路線；PayUni 直連 UPP 留著但沒有憑證。兩者共用 public.payments 與
 * public.webhook_events —— 那是 0005 刻意的設計：webhook_events 的鍵是
 * `unique (gateway, event_key)`，payments 的唯一索引是 `(gateway, gateway_tx_id)`，
 * 所以同一個 order_no 在兩個 gateway 底下是兩列，不會互相蓋掉。
 *
 * 下面每一支函式因此都收一個 `gateway` 參數。它有預設值 "payuni" **只是為了讓
 * 既有呼叫端一行都不用改**（那條路的行為必須逐字元不變），新的呼叫端一律明寫。
 * ⚠️ 傳錯 gateway 的後果是「去重鎖鎖到別人的鍵」——重送不會被擋，或真通知被誤判
 *    成重複。這個參數沒有「差不多就好」的空間。
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
 * Records that we are about to send this order to a gateway.
 *
 * gateway_tx_id is set to order_no — the same string we send as PayUni's
 * MerTradeNo and as 黑貓 PAY 的 cust_order_no — so the unique index
 * payments_gateway_tx_idx makes "one live transaction per order per gateway" a
 * database fact rather than a convention. A retry of the same order therefore
 * hits 23505 and is treated as "already recorded", which is correct: the
 * shopper is being sent to the same trade number again.
 */
export async function recordPaymentIntent(
  order: {
    id: string;
    order_no: string;
    total: number;
  },
  gateway: string = "payuni",
): Promise<void> {
  const { error } = await supabaseAdmin().from("payments").insert({
    order_id: order.id,
    gateway,
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
  gateway: string = "payuni",
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("payments")
    .update(patch)
    .eq("gateway", gateway)
    .eq("gateway_tx_id", orderNo);
  if (error) console.error("[payments] updatePaymentRow failed", gateway, orderNo, error);
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
  gateway: string = "payuni",
): Promise<ClaimResult> {
  const { error } = await supabaseAdmin()
    .from("webhook_events")
    .insert({ gateway, event_key: eventKey, payload });
  if (!error) return "claimed";
  if (error.code === UNIQUE_VIOLATION) return "duplicate";
  // ⚠️ "error" 與 "duplicate" **一定要分開回**。快樂手那一版把兩者壓成同一個
  //    false，於是資料庫抖動一秒 = 那則通知被當成重複、靜默 ack、永遠不再處理。
  //    呼叫端看到 "error" 必須回 5xx 逼上游重送。
  console.error("[payments] claimWebhookEvent failed", gateway, eventKey, error);
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
export async function releaseWebhookClaim(
  eventKey: string,
  gateway: string = "payuni",
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("webhook_events")
    .delete()
    .eq("gateway", gateway)
    .eq("event_key", eventKey);
  if (error) console.error("[payments] releaseWebhookClaim failed", gateway, eventKey, error);
}

/** Records an event we refused to act on, for later reconciliation. */
export async function annotateWebhookEvent(
  eventKey: string,
  payload: Record<string, unknown>,
  gateway: string = "payuni",
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("webhook_events")
    .update({ payload })
    .eq("gateway", gateway)
    .eq("event_key", eventKey);
  if (error) console.error("[payments] annotateWebhookEvent failed", gateway, eventKey, error);
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

/**
 * The dedupe key for one 黑貓 PAY (COCS) APN notification.
 *
 * 同一個原則、不同的欄位名：(契客訂單編號, 黑貓的交易識別碼, 狀態碼)。
 * 規格 P87 說同一個狀態碼最多重送 3 次，重送時這三個欄位一字不變。
 *
 * ⚠️ **`nonce` 絕對不可以進來。** 規格 P89 明寫它是「不會重覆的時間+亂數組合」，
 *    每一次重送都不一樣 —— 把它放進鍵裡，每一次重送都會長得像新事件，去重就
 *    完全失效（而 checksum 是拿 nonce 去算的，所以它很容易被順手抄進來）。
 *
 * ⚠️ `amount` 也不進來：金額不是事件身分的一部分，而且拿通知自稱的金額當鍵，
 *    等於讓偽造者改一個數字就繞過去重。
 */
export function eventKeyForBlackcat(body: Record<string, unknown>): string {
  const orderNo = String(body.order_no ?? "-") || "-";
  const transId = String(body.trans_id ?? "-") || "-";
  const status = String(body.status ?? "-") || "-";
  return `${orderNo}:${transId}:${status}`;
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
  detail: {
    tradeNo?: string;
    amount: number;
    raw: Record<string, unknown>;
    /** 哪一個金流。決定要更新 payments 的哪一列，以及 log 的前綴。 */
    gateway?: string;
  },
): Promise<MarkPaidResult> {
  const db = supabaseAdmin();
  const gateway = detail.gateway ?? "payuni";
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
    await updatePaymentRow(
      order.order_no,
      {
        status: "paid",
        amount: detail.amount,
        paid_at: new Date().toISOString(),
        gateway_trans_id: detail.tradeNo ?? null,
        raw_response: { ...detail.raw, tradeNo: detail.tradeNo ?? null },
      },
      gateway,
    );
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
      `[${gateway}] PAID AFTER CANCEL order=${order.order_no} amount=${detail.amount} — 款項已收但訂單已取消（庫存可能已回收），需人工對帳`,
    );
    await updatePaymentRow(
      order.order_no,
      {
        status: "paid",
        amount: detail.amount,
        paid_at: new Date().toISOString(),
        gateway_trans_id: detail.tradeNo ?? null,
        raw_response: { ...detail.raw, reconcile: "paid_after_cancel" },
      },
      gateway,
    );
    return { ok: false, reason: "paid_after_cancel" };
  }
  // Some other state moved underneath us (manual admin action, a second
  // gateway). Leave it alone and say so.
  console.error(
    `[${gateway}] STALE PAID CALLBACK order=${order.order_no} status=${fresh.status} payment_status=${fresh.payment_status}`,
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
  detail: { reason: string; raw: Record<string, unknown>; gateway?: string },
): Promise<MarkFailedResult> {
  const gateway = detail.gateway ?? "payuni";
  // A late failure about an order that has already moved on is exactly the
  // Realreal bug. Short-circuit before writing anything.
  if (order.payment_status === "paid" || TERMINAL_STATUSES.has(order.status)) {
    console.warn(
      `[${gateway}] 忽略遲到的失敗通知 order=${order.order_no} status=${order.status} payment_status=${order.payment_status}`,
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
    console.warn(`[${gateway}] 失敗通知的 CAS 未命中（狀態已變動） order=${order.order_no}`);
    return "ignored_terminal";
  }

  await updatePaymentRow(
    order.order_no,
    {
      status: "failed",
      raw_response: detail.raw,
    },
    gateway,
  );
  return "changed";
}
