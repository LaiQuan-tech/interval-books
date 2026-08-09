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
 */
import { useEffect, useRef } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { useCart } from "@/lib/cart";
import { fetchOrderConfirmation } from "@/lib/checkout-fns";
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

function CheckoutComplete() {
  const t = useT();
  const { order } = Route.useLoaderData();
  const { ui } = useSiteContent();
  const clear = useCart((s) => s.clear);
  const cleared = useRef(false);

  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.title,
  });

  /**
   * Empty the cart only once the order has actually been read back.
   *
   * Realreal originally cleared unconditionally on mount and stranded anyone
   * whose payment failed in front of an empty cart with no way to retry. The
   * same trap applies here in a milder form: if this page is reached with a bad
   * token, the order may not exist, and throwing away the cart would destroy
   * the only record of what the shopper wanted.
   */
  useEffect(() => {
    if (!order || cleared.current) return;
    cleared.current = true;
    clear();
  }, [order, clear]);

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

  return (
    <PageShell>
      <PageHeader
        eyebrow={`Order  ／  ${t(PAGE.eyebrowSuffix)}`}
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-32 max-w-2xl">
        <div className="flex items-center gap-4 border border-foreground p-6">
          <Check className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="eyebrow text-xl">{t(PAGE.orderNo)}</p>
            <p className="mt-1 font-serif text-2xl tabular-nums break-all">{order.orderNo}</p>
          </div>
        </div>

        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          {t(PAGE.paymentPending)}
        </p>

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
