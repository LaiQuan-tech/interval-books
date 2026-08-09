import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import { PriceTag, QuantityStepper, StockBadge } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { cartInputFor, useCart } from "@/lib/cart";
import { imageFor } from "@/lib/images";
import { fetchActiveProductBySlug, isSoldOut, remainingFor } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import curatedImg from "@/assets/curated-objects.jpg";

/**
 * Page copy. The product's own title/summary/description come from the
 * database; these are the surrounding chrome plus the meta fallbacks used
 * before the product is known (and by scripts/check-meta.mjs, which resolves
 * this object statically — keep every entry a plain zh/en/ja string literal).
 */
const PAGE = {
  metaTitle: {
    zh: "商品｜小時光書店 Interval Books",
    en: "Item｜Interval Books",
    ja: "商品｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "小時光書店的選物與書籍，一件一件挑過才留下來。",
    en: "Books and objects from Interval Books — each one chosen by hand before it earned its place.",
    ja: "小時光書店が一点ずつ選んだ書籍とセレクト品をご紹介します。",
  },
  back: { zh: "回到選購", en: "Back to shop", ja: "ショップへ戻る" },
  quantity: { zh: "數量", en: "Quantity", ja: "数量" },
  remaining: { zh: "尚有庫存", en: "In stock", ja: "在庫あり" },
  remainingCount: { zh: "僅剩", en: "Only", ja: "残り" },
  remainingUnit: { zh: "件", en: "left", ja: "点" },
  seatsLeft: { zh: "尚餘名額", en: "Places left", ja: "残り枠" },
  unlimited: { zh: "常備品項", en: "Always in stock", ja: "常時ご用意" },
  soldOutNote: {
    zh: "這件已經售完了。歡迎來信或到店詢問補貨。",
    en: "This one has sold out. Write to us or drop by to ask about a restock.",
    ja: "こちらは完売しました。再入荷についてはメールまたは店頭でお問い合わせください。",
  },
  addedToast: { zh: "已加入購物車", en: "Added to cart", ja: "カートに入れました" },
  cappedToast: {
    zh: "已達可購買數量上限",
    en: "That is all we have available",
    ja: "ご購入いただける上限に達しました",
  },
  soldOutToast: {
    zh: "這件商品目前售完",
    en: "This item is sold out",
    ja: "この商品は完売しています",
  },
  unavailable: {
    zh: "商品資料暫時無法載入，請稍後再試。",
    en: "This item is temporarily unavailable. Please try again shortly.",
    ja: "商品情報を読み込めませんでした。しばらくしてからお試しください。",
  },
  aboutThis: { zh: "關於這件", en: "About this item", ja: "この商品について" },
};

/**
 * Prefers the product's own localized copy and falls back to the page-level
 * constant before the product is known (loader failure) — and, importantly,
 * gives scripts/check-meta.mjs a statically resolvable object literal to audit.
 */
function metaOr(value: Localized | undefined, fallback: Localized): Localized {
  return value ?? fallback;
}

export const Route = createFileRoute("/shop/$slug")({
  loader: async ({ params }) => {
    const { product, unavailable } = await fetchActiveProductBySlug(params.slug);
    // A slug that resolves to nothing really is a 404. A failed read is not —
    // that would tell crawlers a live product is gone because Supabase blinked.
    if (!product && !unavailable) throw notFound();
    return { product, unavailable };
  },
  head: ({ loaderData }) => {
    const product = loaderData?.product ?? null;
    const ogImg = imageFor(product?.imageKey, curatedImg);
    const title = metaOr(product?.title, PAGE.metaTitle);
    const description = metaOr(product?.summary, PAGE.metaDescription);
    return {
      meta: [
        { title: title.zh },
        { name: "description", content: description.zh },
        { property: "og:title", content: title.zh },
        { property: "og:description", content: description.zh },
        { property: "og:image", content: ogImg },
        { name: "twitter:image", content: ogImg },
      ],
    };
  },
  component: ProductDetail,
});

function ProductDetail() {
  const t = useT();
  const { product, unavailable } = Route.useLoaderData();
  const { ui } = useSiteContent();
  const addItem = useCart((s) => s.addItem);
  const [qty, setQty] = useState(1);

  useDocumentMeta({
    title: metaOr(product?.title, PAGE.metaTitle),
    description: metaOr(product?.summary, PAGE.metaDescription),
    ogTitle: metaOr(product?.title, PAGE.metaTitle),
    ogImage: imageFor(product?.imageKey, curatedImg),
  });

  if (!product) {
    return (
      <PageShell>
        <section className="container-editorial py-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {t(PAGE.unavailable)}
          </p>
          <BackLink label={t(PAGE.back)} />
        </section>
      </PageShell>
    );
  }

  const soldOut = isSoldOut(product);
  const remaining = remainingFor(product);
  const isBooking = product.productType === "event" || product.productType === "journey";

  function handleAdd() {
    // `product` is narrowed above, but the closure needs its own guard.
    if (!product || soldOut) return;
    const result = addItem(cartInputFor(product, qty));
    if (result === "added") {
      toast.success(t(PAGE.addedToast));
      setQty(1);
    } else if (result === "capped") {
      toast.warning(t(PAGE.cappedToast));
    } else {
      toast.error(t(PAGE.soldOutToast));
    }
  }

  return (
    <PageShell>
      <section className="container-editorial pt-12 md:pt-16">
        <BackLink label={t(PAGE.back)} />
      </section>

      <section className="container-editorial pb-24 pt-8 grid gap-12 md:grid-cols-2 md:gap-16">
        <div className="aspect-[4/5] overflow-hidden bg-muted">
          <img
            src={imageFor(product.imageKey, curatedImg)}
            alt={t(product.title)}
            className={`h-full w-full object-cover ${soldOut ? "opacity-60" : ""}`}
          />
        </div>

        <div className="flex flex-col">
          <p className="eyebrow text-2xl">{t(PRODUCT_TYPE_LABELS[product.productType])}</p>
          <h1 className="display mt-4 text-4xl md:text-5xl leading-tight">{t(product.title)}</h1>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            {t(product.summary)}
          </p>

          <PriceTag
            price={product.price}
            compareAtPrice={product.compareAtPrice}
            size="lg"
            className="mt-8"
          />

          <div className="mt-5">
            {soldOut ? (
              <StockBadge tone="alert">{t(ui.buttons.soldOut)}</StockBadge>
            ) : remaining === null ? (
              <StockBadge>{t(PAGE.unlimited)}</StockBadge>
            ) : remaining <= 5 ? (
              <StockBadge tone="alert">
                {isBooking
                  ? `${t(PAGE.seatsLeft)} ${remaining}`
                  : `${t(PAGE.remainingCount)} ${remaining} ${t(PAGE.remainingUnit)}`}
              </StockBadge>
            ) : (
              <StockBadge>
                {isBooking ? `${t(PAGE.seatsLeft)} ${remaining}` : t(PAGE.remaining)}
              </StockBadge>
            )}
          </div>

          <div className="rule my-8" />

          {soldOut ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{t(PAGE.soldOutNote)}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <QuantityStepper
                value={qty}
                max={remaining}
                onChange={(next) => setQty(Math.max(1, next))}
                label={t(PAGE.quantity)}
              />
              <button
                type="button"
                onClick={handleAdd}
                className="border border-foreground px-6 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
              >
                {t(ui.buttons.addToCart)}
              </button>
              <Link
                to="/cart"
                className="text-xs tracking-widest text-muted-foreground hover-underline hover:text-foreground transition-colors"
              >
                {t(ui.buttons.viewCart)}
              </Link>
            </div>
          )}

          {/* `unavailable` can only be true here when the product came back
              null, which the early return above already handled — but keeping
              the branch means a future loader change cannot silently drop it. */}
          {unavailable && (
            <p className="mt-6 text-sm text-muted-foreground">{t(PAGE.unavailable)}</p>
          )}
        </div>
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-12 max-w-3xl">
          <p className="eyebrow text-2xl">{t(PAGE.aboutThis)}</p>
          <p className="mt-6 whitespace-pre-line text-base leading-relaxed text-foreground/80">
            {t(product.description)}
          </p>
        </div>
      </section>
    </PageShell>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      to="/shop"
      className="inline-flex items-center gap-2 text-xs tracking-widest text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
