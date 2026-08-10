/**
 * /checkout/complete?token=… — the order exists; here is its number.
 *
 * WHY THE TOKEN AND NOT THE ORDER NUMBER
 * --------------------------------------
 * orders.order_no is IB-YYYY00000001, IB-YYYY00000002, … — quotable on the
 * phone, and for exactly that reason trivially enumerable. Keying this page on
 * it would let anyone walk the sequence and read what every customer spent.
 * orders.public_token is 24 random bytes and exists in 0005_commerce_orders.sql
 * for precisely this purpose ("Unguessable order lookup key for guests").
 *
 * What comes back is still deliberately thin — order number, amounts, lines. No
 * name, no email, no phone, no address, and the token is never echoed. A URL
 * ends up in browser history and over the shoulder of the person next to you;
 * it should not be a key to somebody's home address.
 *
 * WHY THE PAYMENT STATE IS RE-READ AND NOT TAKEN FROM THE URL
 * ----------------------------------------------------------
 * This is also PayUni's ReturnURL — the page the shopper lands on after paying
 * — so the gateway appends its own parameters on the way back. None of them are
 * read here. "Paid" is whatever the database says when this page asks it, which
 * is the only version of the answer that a shopper cannot edit in the address
 * bar. The gateway's real report arrives out of band at the webhook
 * (src/server/payuni-webhook.ts); this page just waits for it to land.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Clock, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { PageShell, PageHeader } from "@/components/PageShell";
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import { Button } from "@/components/ui/button";
import { useLang, useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { useCart } from "@/lib/cart";
import { checkoutErrorText, type OrderConfirmation } from "@/lib/checkout";
import { fetchOrderConfirmation, retryPayment } from "@/lib/checkout-fns";
import { submitPaymentForm } from "@/lib/payment-redirect";
import { formatPrice } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";

const PAGE = {
  metaTitle: {
    zh: "訂單完成｜小時光書店 Interval Books",
    en: "Order complete｜Interval Books",
    ja: "ご注文完了｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "你的小時光書店訂單已經成立，這裡是訂單編號與明細。",
    en: "Your Interval Books order has been created. Here is the order number and what is in it.",
    ja: "小時光書店のご注文が成立しました。ご注文番号と内容はこちらです。",
  },
  eyebrowSuffix: { zh: "訂單完成", en: "Order complete", ja: "ご注文完了" },
  title: { zh: "訂單已成立", en: "Your order is in", ja: "ご注文を承りました" },
  intro: {
    zh: "謝謝你。我們會盡快與你聯繫付款與寄送方式，訂單編號請先留著。",
    en: "Thank you. We will be in touch shortly about payment and delivery — please keep the order number.",
    ja: "ありがとうございます。お支払いとお届けについて追ってご連絡いたします。ご注文番号はお控えください。",
  },
  orderNo: { zh: "訂單編號", en: "Order number", ja: "ご注文番号" },
  summary: { zh: "訂單明細", en: "Order summary", ja: "ご注文内容" },
  subtotal: { zh: "小計", en: "Subtotal", ja: "小計" },
  shipping: { zh: "運費", en: "Shipping", ja: "送料" },
  free: { zh: "免運費", en: "Free", ja: "送料無料" },
  total: { zh: "應付總額", en: "Total", ja: "合計" },
  paymentPending: {
    zh: "這筆訂單尚未付款。線上付款開放前，我們會直接與你聯繫付款方式。",
    en: "This order has not been paid yet. Until online payment opens, we will arrange it with you directly.",
    ja: "このご注文はまだお支払いいただいておりません。オンライン決済の開始まで、個別にご案内いたします。",
  },
  titlePaid: { zh: "付款完成", en: "Payment complete", ja: "お支払い完了" },
  titleWaiting: { zh: "等待付款結果", en: "Waiting for payment", ja: "お支払いの確認中" },
  paid: {
    zh: "已收到你的付款，謝謝。我們會盡快為你備貨並通知寄送進度。",
    en: "We have received your payment — thank you. We will prepare your order and let you know when it ships.",
    ja: "お支払いを確認いたしました。ありがとうございます。準備が整い次第、発送のご連絡をいたします。",
  },
  waiting: {
    zh: "還在等金流回覆付款結果，這通常只需要幾秒。這一頁會自動更新，購物車會先幫你保留著。",
    en: "We are still waiting for the payment result — this usually takes a few seconds. This page updates itself, and your cart is kept in the meantime.",
    ja: "決済結果の確認中です。通常は数秒で完了します。このページは自動で更新され、その間カートは保持されます。",
  },
  failed: {
    zh: "這次付款沒有完成。訂單與購物車都還在，你可以直接重新付款。",
    en: "That payment did not go through. Your order and your cart are both still here — you can try paying again.",
    ja: "お支払いが完了しませんでした。ご注文もカートもそのままですので、再度お支払いいただけます。",
  },
  retry: { zh: "重新付款", en: "Try paying again", ja: "もう一度支払う" },
  retrying: { zh: "前往付款頁…", en: "Opening the payment page…", ja: "決済ページへ移動中…" },
  backToCart: { zh: "回到購物車", en: "Back to cart", ja: "カートへ戻る" },
  notFound: {
    zh: "找不到這筆訂單。連結可能不完整，或訂單並未成立。",
    en: "We could not find that order. The link may be incomplete, or the order was never created.",
    ja: "ご注文が見つかりませんでした。リンクが不完全か、ご注文が成立していない可能性があります。",
  },
};

export const Route = createFileRoute("/checkout/complete")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => {
    // Matches the server function's own minimum, so an obviously-truncated
    // link renders "not found" instead of a validation error.
    if (deps.token.length < 16) return { order: null };
    return { order: await fetchOrderConfirmation({ data: { token: deps.token } }) };
  },
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.title.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
      // Per-order and behind a secret; must never be indexed or followed.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: CheckoutComplete,
});

/** How long to keep asking the server whether the gateway has reported in. */
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 30; // ≈2 minutes, then stop and let the shopper reload

function CheckoutComplete() {
  const t = useT();
  const { lang } = useLang();
  const { token } = Route.useSearch();
  const { order: initialOrder } = Route.useLoaderData();
  const { ui } = useSiteContent();
  const clear = useCart((s) => s.clear);
  const cleared = useRef(false);

  const [order, setOrder] = useState<OrderConfirmation | null>(initialOrder);
  const [retrying, setRetrying] = useState(false);

  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.title,
  });

  /**
   * Empty the cart only once the order no longer owes anybody money.
   *
   * THIS CONDITION IS THE WHOLE POINT — do not simplify it back to `if (order)`.
   * Arriving here does not mean the shopper paid: with a gateway in the flow
   * there is now a middle state ("order created, payment not settled") that did
   * not exist before, and it is reached by anyone who closes PayUni's page or
   * has a card declined. Clearing the cart in that state is what sent Realreal's
   * shoppers to an empty cart with an unpaid order and no way to retry.
   *
   * `awaitingPayment` is computed on the server from the order's own columns
   * (see getOrderByToken) — never from a URL parameter the gateway controls —
   * and is false both for a settled card order and for an offline order, which
   * has no payment step to wait for.
   */
  useEffect(() => {
    if (!order || order.awaitingPayment || cleared.current) return;
    cleared.current = true;
    clear();
  }, [order, clear]);

  /**
   * While the gateway still owes us an answer, ask the server again.
   *
   * The shopper is usually back here before PayUni's server-to-server
   * notification has been processed, so the first read almost always says
   * "pending". Polling turns that into a page that resolves itself instead of
   * one that needs a manual refresh. Bounded on purpose: an order that is still
   * unsettled after two minutes needs a human, not more requests.
   */
  useEffect(() => {
    if (!token || !order) return;
    if (!order.awaitingPayment || order.paymentStatus !== "pending") return;

    let attempts = 0;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      attempts += 1;
      if (attempts > POLL_MAX_ATTEMPTS) {
        clearInterval(timer);
        return;
      }
      void fetchOrderConfirmation({ data: { token } })
        .then((fresh) => {
          if (!stopped && fresh) setOrder(fresh);
        })
        .catch(() => {
          /* transient; the next tick tries again */
        });
    }, POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [token, order]);

  /** Re-issues the PayUni form for an order whose payment did not complete. */
  const onRetry = useCallback(async () => {
    if (!token) return;
    setRetrying(true);
    try {
      const result = await retryPayment({ data: { token } });
      if (!result.ok) {
        toast.error(checkoutErrorText(result.code, lang));
        setRetrying(false);
        return;
      }
      // Navigating away — leave `retrying` true so the button cannot be
      // pressed twice while the browser is on its way to PayUni.
      submitPaymentForm(result.payment);
    } catch (err) {
      toast.error(checkoutErrorText(err, lang));
      setRetrying(false);
    }
  }, [token, lang]);

  if (!order) {
    return (
      <PageShell>
        <PageHeader eyebrow={`Order  ／  ${t(PAGE.eyebrowSuffix)}`} title={t(PAGE.title)} />
        <section className="container-editorial pb-32">
          <div className="border border-border p-10">
            <p className="text-sm text-muted-foreground">{t(PAGE.notFound)}</p>
            <Link
              to="/shop"
              className="mt-8 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
            >
              {t(ui.buttons.continueShopping)}
            </Link>
          </div>
        </section>
      </PageShell>
    );
  }

  // Three shapes of the same page, chosen from the server's answer only.
  const isPaid = order.paymentStatus === "paid";
  const isFailed = order.awaitingPayment && order.paymentStatus === "failed";
  const isWaiting = order.awaitingPayment && order.paymentStatus === "pending";

  const StatusIcon = isPaid ? Check : isFailed ? TriangleAlert : isWaiting ? Clock : Check;
  const heading = isPaid
    ? PAGE.titlePaid
    : isWaiting
      ? PAGE.titleWaiting
      : isFailed
        ? PAGE.titleWaiting
        : PAGE.title;
  const statusCopy = isPaid
    ? PAGE.paid
    : isFailed
      ? PAGE.failed
      : isWaiting
        ? PAGE.waiting
        : PAGE.paymentPending;

  return (
    <PageShell>
      <PageHeader
        eyebrow={`Order  ／  ${t(PAGE.eyebrowSuffix)}`}
        title={t(heading)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-32 max-w-2xl">
        <div className="flex items-center gap-4 border border-foreground p-6">
          <StatusIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="eyebrow text-xl">{t(PAGE.orderNo)}</p>
            <p className="mt-1 font-serif text-2xl tabular-nums break-all">{order.orderNo}</p>
          </div>
        </div>

        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">{t(statusCopy)}</p>

        {order.awaitingPayment && (
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Button type="button" onClick={onRetry} disabled={retrying}>
              {retrying ? t(PAGE.retrying) : t(PAGE.retry)}
            </Button>
            <Link to="/cart" className="text-xs tracking-widest underline underline-offset-4">
              {t(PAGE.backToCart)}
            </Link>
          </div>
        )}

        <div className="mt-12 border border-border p-7 md:p-8">
          <p className="eyebrow text-xl">{t(PAGE.summary)}</p>

          <ul className="mt-6 space-y-4 border-b border-border pb-6">
            {order.items.map((item, i) => (
              <li key={i} className="flex justify-between gap-4 text-sm">
                <span className="min-w-0">
                  <span className="eyebrow block text-lg">
                    {t(PRODUCT_TYPE_LABELS[item.productType])}
                  </span>
                  <span className="block">{t(item.name)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatPrice(item.unitPrice)} × {item.quantity}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatPrice(item.subtotal)}</span>
              </li>
            ))}
          </ul>

          <dl className="mt-6 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t(PAGE.subtotal)}</dt>
              <dd className="tabular-nums">{formatPrice(order.subtotal)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t(PAGE.shipping)}</dt>
              <dd className="tabular-nums">
                {order.shippingFee === 0 ? t(PAGE.free) : formatPrice(order.shippingFee)}
              </dd>
            </div>
          </dl>

          <div className="rule my-6" />

          <div className="flex items-baseline justify-between gap-4">
            <span className="eyebrow text-xl">{t(PAGE.total)}</span>
            <span className="font-serif text-2xl tabular-nums">{formatPrice(order.total)}</span>
          </div>
        </div>

        <Link
          to="/shop"
          className="mt-10 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
        >
          {t(ui.buttons.continueShopping)}
        </Link>
      </section>
    </PageShell>
  );
}
