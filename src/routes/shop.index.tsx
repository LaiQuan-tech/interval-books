import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import { PriceTag, StockBadge } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { eyebrowOf, fetchPage, pageText } from "@/lib/cms";
import { imageFor } from "@/lib/images";
import { fetchActiveProducts, isSoldOut, remainingFor, SHOP_PRODUCT_TYPES } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import curatedImg from "@/assets/curated-objects.jpg";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "選購 Shop｜小時光書店 Interval Books",
    en: "Shop｜Interval Books",
    ja: "ショップ｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "書籍、選物、活動與策旅名額，都可以在這裡直接選購。每一件都是我們親手挑過、留在店裡的時間。",
    en: "Books, curated objects, event tickets and journey places — all available here. Everything we sell is something we chose by hand and kept in the shop.",
    ja: "書籍、セレクト品、イベントや旅の参加枠を、こちらからお求めいただけます。すべて私たちが手に取って選んだものです。",
  },
  eyebrowSuffix: { zh: "選購", en: "Shop", ja: "ショップ" },
  title: {
    zh: "把一段時光帶回家",
    en: "Take an interval home",
    ja: "ひとときを、持ち帰る",
  },
  intro: {
    zh: "書、器物、茶、活動與策旅名額。清單很短，因為每一件都得先通過我們自己的日常。",
    en: "Books, vessels, tea, events and journey places. The list is short because everything on it first had to survive our own daily use.",
    ja: "本、器、茶、イベントと旅の枠。並ぶ数は多くありません。まず私たち自身の日常を通ったものだけを置いているからです。",
  },
  filterAll: { zh: "全部", en: "All", ja: "すべて" },
  empty: {
    zh: "目前沒有上架中的商品，歡迎到店裡看看。",
    en: "Nothing is on sale right now — do come and see us in the shop.",
    ja: "現在お取り扱い中の商品はありません。ぜひ店頭にもお立ち寄りください。",
  },
  emptyFiltered: {
    zh: "這個分類目前沒有商品。",
    en: "No items in this category right now.",
    ja: "このカテゴリーの商品は現在ありません。",
  },
  unavailable: {
    zh: "商品資料暫時無法載入，請稍後再試。",
    en: "The catalogue is temporarily unavailable. Please try again shortly.",
    ja: "商品情報を読み込めませんでした。しばらくしてからお試しください。",
  },
  lowStock: { zh: "僅剩", en: "Only", ja: "残り" },
  lowStockUnit: { zh: "件", en: "left", ja: "点" },
  // event/journey are booked, not stocked — "2 pieces left" is the wrong noun
  // for a reading circle.
  seatsLeft: { zh: "尚餘名額", en: "Places left", ja: "残り枠" },
};

/** Below this, the remaining quantity is worth saying out loud on the card. */
const LOW_STOCK_THRESHOLD = 5;

export const Route = createFileRoute("/shop/")({
  loader: async () => {
    const [page, catalogue] = await Promise.all([fetchPage("shop"), fetchActiveProducts()]);
    return { page, catalogue };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, curatedImg);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:image", content: ogImg },
        { name: "twitter:image", content: ogImg },
      ],
    };
  },
  component: Shop,
});

function Shop() {
  const t = useT();
  const { page, catalogue } = Route.useLoaderData();
  const p = pageText(page);
  const { ui } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, curatedImg);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: heroSrc,
  });

  const { products, unavailable } = catalogue;

  // Only offer a filter for types that actually have something to show, so the
  // shop never presents a pill that leads to an empty grid.
  const presentTypes = SHOP_PRODUCT_TYPES.filter((type) =>
    products.some((prod) => prod.productType === type),
  );
  const [filter, setFilter] = useState<string>("all");
  // Products are already ordered by sort_order (then id) in the query — see
  // fetchActiveProducts — and .filter preserves that order.
  const list = filter === "all" ? products : products.filter((prod) => prod.productType === filter);

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Shop", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className="container-editorial pb-12">
        <div className="mx-auto w-4/5 aspect-[3/4] md:aspect-[16/10] overflow-hidden bg-muted">
          <img
            src={heroSrc}
            alt={t(p.title(PAGE.title))}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </div>
      </section>

      {presentTypes.length > 1 && (
        <section className="container-editorial pb-12 flex flex-wrap gap-3 text-xs tracking-widest">
          {["all", ...presentTypes].map((f) => {
            const label =
              f === "all"
                ? t(p.block("filters.all", PAGE.filterAll))
                : t(PRODUCT_TYPE_LABELS[f as keyof typeof PRODUCT_TYPE_LABELS]);
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={active}
                className={`px-4 py-2 border transition-colors ${
                  active
                    ? "border-foreground bg-foreground text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            );
          })}
        </section>
      )}

      {/* "The read failed" and "there is genuinely nothing for sale" are
          different facts and get different copy — see the header of
          src/lib/shop.ts. */}
      {unavailable ? (
        <section className="container-editorial pb-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {t(p.block("unavailable", PAGE.unavailable))}
          </p>
        </section>
      ) : list.length === 0 ? (
        <section className="container-editorial pb-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {products.length === 0
              ? t(p.block("empty", PAGE.empty))
              : t(p.block("emptyFiltered", PAGE.emptyFiltered))}
          </p>
        </section>
      ) : (
        <section className="container-editorial pb-32 grid gap-px bg-border border border-border sm:grid-cols-2 lg:grid-cols-3">
          {list.map((prod) => {
            const soldOut = isSoldOut(prod);
            const remaining = remainingFor(prod);
            const low =
              !soldOut && remaining !== null && remaining > 0 && remaining <= LOW_STOCK_THRESHOLD;
            const isBooking = prod.productType === "event" || prod.productType === "journey";
            return (
              <article key={prod.id} className="bg-background flex flex-col">
                <Link
                  to="/shop/$slug"
                  params={{ slug: prod.slug }}
                  className="group flex flex-1 flex-col"
                >
                  <div className="aspect-[4/3] overflow-hidden bg-muted">
                    <img
                      src={imageFor(prod.imageKey, curatedImg)}
                      alt={t(prod.title)}
                      className={`h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03] ${
                        soldOut ? "opacity-50" : ""
                      }`}
                      loading="lazy"
                    />
                  </div>
                  <div className="flex flex-1 flex-col p-7 md:p-8">
                    <p className="eyebrow text-2xl">{t(PRODUCT_TYPE_LABELS[prod.productType])}</p>
                    <h2 className="font-serif text-xl mt-3 leading-snug group-hover:underline underline-offset-4">
                      {t(prod.title)}
                    </h2>
                    <p className="mt-3 flex-1 text-sm leading-relaxed text-muted-foreground">
                      {t(prod.summary)}
                    </p>
                    <PriceTag
                      price={prod.price}
                      compareAtPrice={prod.compareAtPrice}
                      className="mt-6"
                    />
                    {(soldOut || low) && (
                      <div className="mt-4">
                        {soldOut ? (
                          <StockBadge tone="alert">{t(ui.buttons.soldOut)}</StockBadge>
                        ) : isBooking ? (
                          <StockBadge>
                            {t(p.block("seatsLeft", PAGE.seatsLeft))} {remaining}
                          </StockBadge>
                        ) : (
                          <StockBadge>
                            {t(p.block("lowStock", PAGE.lowStock))} {remaining}{" "}
                            {t(p.block("lowStockUnit", PAGE.lowStockUnit))}
                          </StockBadge>
                        )}
                      </div>
                    )}
                  </div>
                </Link>
              </article>
            );
          })}
        </section>
      )}
    </PageShell>
  );
}
