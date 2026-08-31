/**
 * /publications —— 地方刊物展
 *
 * 126 本台灣與日本的地方刊物，全部上展覽頁；其中在店裡真的有貨、有定價的那幾本
 * 掛購買鈕。「可買」與「只展示」的分界線是 publications.product_id：
 *
 *   product_id 為 null            → 只展示，顯示「到店選購」
 *   product_id 指到一件 active 商品 → 購買鈕，可售量走 product_availability
 *   product_id 有值但商品讀不到     → 也只展示。商品讀失敗不該讓展覽頁跟著壞掉，
 *                                    這正是 loader 分兩次讀的理由（見 lib/publications.ts）。
 *
 * 所以「之後在後台補完定價」不需要動這一頁：後台把某一本連上庫存商品之後，
 * 下一次載入這一頁就長出購買鈕。
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageShell, PageHeader } from "@/components/PageShell";
import { PriceTag, StockBadge } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { eyebrowOf, fetchPage, pageText } from "@/lib/cms";
import { cartInputFor, useCart } from "@/lib/cart";
import { imageFor } from "@/lib/images";
import {
  fetchPublications,
  presentRegionGroups,
  regionGroupOf,
  SHEET_LABELS,
  type PublicationEntry,
  type PublicationSheet,
} from "@/lib/publications";
import { fetchActiveProductsByIds, isSoldOut, remainingFor, type ShopProduct } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import bookstoreImg from "@/assets/bookstore-interior.jpg";

/** 後備文案 —— 只有在 Supabase 讀不到 pages 那一列時才會用到。 */
const PAGE = {
  metaTitle: {
    zh: "地方刊物展｜小時光書店 Interval Books",
    en: "Local Publications｜Interval Books",
    ja: "地域の刊行物展｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "126 本來自台灣與日本各地的地方刊物，記錄一個地方怎麼被自己的人寫下來。店裡有貨的可直接選購。",
    en: "126 local publications from across Taiwan and Japan — a record of how a place gets written down by the people who live in it. Titles we have in stock can be bought here.",
    ja: "台湾と日本各地から集めた126冊の地域刊行物。土地の人が自らの手で記した記録です。在庫のあるものはそのままご購入いただけます。",
  },
  eyebrowSuffix: { zh: "地方刊物展", en: "Local Publications", ja: "地域の刊行物展" },
  title: {
    zh: "一個地方，怎麼被自己的人寫下來",
    en: "How a place gets written down by its own people",
    ja: "その土地の人が、その土地を書く",
  },
  intro: {
    zh: "從基隆的漁村到日本的山間小鎮，126 本地方刊物擺在同一張桌子上。它們大多不是為了賣而做的，是為了留下來。",
    en: "From a fishing village in Keelung to a mountain town in Japan, 126 local publications share one table. Most were not made to be sold — they were made to remain.",
    ja: "基隆の漁村から日本の山あいの町まで、126冊の地域刊行物がひとつの机に並びます。その多くは売るためではなく、遺すためにつくられました。",
  },
  filterAll: { zh: "全部", en: "All", ja: "すべて" },
  regionLabel: { zh: "關注地域", en: "Region", ja: "対象地域" },
  publisherLabel: { zh: "製作單位", en: "Published by", ja: "発行" },
  issuesLabel: { zh: "集數", en: "Issues", ja: "号" },
  readMore: { zh: "刊物介紹", en: "About this title", ja: "この刊行物について" },
  visitSite: { zh: "前往刊物網站", en: "Visit publication site", ja: "刊行物のサイトへ" },
  displayOnly: {
    zh: "此本僅供店內展示",
    en: "On display in store only",
    ja: "店頭展示のみ",
  },
  countSuffix: { zh: "本", en: "titles", ja: "冊" },
  empty: {
    zh: "這個條件下沒有刊物，換一個地域看看。",
    en: "Nothing matches this filter — try another region.",
    ja: "この条件に合う刊行物はありません。別の地域をお試しください。",
  },
  unavailable: {
    zh: "刊物資料暫時無法載入，請稍後再試。",
    en: "The publication list is temporarily unavailable. Please try again shortly.",
    ja: "刊行物の情報を読み込めませんでした。しばらくしてからお試しください。",
  },
  addedToast: { zh: "已加入購物車", en: "Added to cart", ja: "カートに入れました" },
  cappedToast: {
    zh: "已達可購買的數量上限",
    en: "That is all we can sell right now",
    ja: "購入可能な数量の上限です",
  },
  soldOutToast: {
    zh: "這一本剛剛售完了",
    en: "This one has just sold out",
    ja: "こちらは完売しました",
  },
  lowStock: { zh: "僅剩", en: "Only", ja: "残り" },
  lowStockUnit: { zh: "本", en: "left", ja: "冊" },
};

/** 低於這個數字才把剩餘量說出來。與 /shop 同一個門檻。 */
const LOW_STOCK_THRESHOLD = 5;

export const Route = createFileRoute("/publications")({
  loader: async () => {
    const [page, list] = await Promise.all([fetchPage("publications"), fetchPublications()]);
    // 第二次讀取只問「這幾個 id 現在賣得動嗎」。刊物讀失敗時 ids 是空的，
    // fetchActiveProductsByIds 直接回空集合，不會多打一次網路。
    const catalogue = await fetchActiveProductsByIds(
      list.publications.map((p) => p.productId).filter((id): id is string => id !== null),
    );
    return { page, list, catalogue };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, bookstoreImg);
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
  component: Publications,
});

type SheetFilter = "all" | PublicationSheet;

function Publications() {
  const t = useT();
  const { page, list, catalogue } = Route.useLoaderData();
  const p = pageText(page);
  const { ui } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, bookstoreImg);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: heroSrc,
  });

  const { publications, unavailable } = list;
  const productById = useMemo(
    () => new Map(catalogue.products.map((prod) => [prod.id, prod])),
    [catalogue.products],
  );

  const [sheet, setSheet] = useState<SheetFilter>("all");
  const [region, setRegion] = useState<string>("all");
  const [open, setOpen] = useState<string | null>(null);

  const sheetFiltered = useMemo(
    () => (sheet === "all" ? publications : publications.filter((e) => e.sheet === sheet)),
    [publications, sheet],
  );

  // 地域選項跟著上一層的選擇走：選了「日本刊物」就不該還看得到「基隆」這個選項。
  const regionGroups = useMemo(() => {
    const sheets: PublicationSheet[] = sheet === "all" ? ["tw", "jp"] : [sheet];
    // 「跨區域／其他」在台灣與日本兩份清單裡都會出現，兩邊都選時要合成一顆按鈕，
    // 不然會有兩個同名選項、同一個 React key。
    const seen = new Set<string>();
    return sheets
      .flatMap((s) => presentRegionGroups(sheetFiltered, s))
      .filter((g) => (seen.has(g.key) ? false : seen.add(g.key)));
  }, [sheetFiltered, sheet]);

  const visible = useMemo(
    () =>
      region === "all" ? sheetFiltered : sheetFiltered.filter((e) => regionGroupOf(e) === region),
    [sheetFiltered, region],
  );

  function changeSheet(next: SheetFilter) {
    setSheet(next);
    setRegion("all"); // 舊的地域選項在新的工作表裡可能根本不存在
    setOpen(null);
  }

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Publications", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      {unavailable ? (
        <section className="container-editorial pb-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {t(p.block("unavailable", PAGE.unavailable))}
          </p>
        </section>
      ) : (
        <>
          <section className="container-editorial pb-8 space-y-4">
            <div
              className="flex flex-wrap gap-3 text-xs tracking-widest"
              data-testid="sheet-filter"
            >
              {(["all", "tw", "jp"] as const).map((f) => {
                const label =
                  f === "all" ? t(p.block("filters.all", PAGE.filterAll)) : t(SHEET_LABELS[f]);
                const active = sheet === f;
                const count =
                  f === "all"
                    ? publications.length
                    : publications.filter((e) => e.sheet === f).length;
                return (
                  <button
                    key={f}
                    onClick={() => changeSheet(f)}
                    aria-pressed={active}
                    className={`px-4 py-2 border transition-colors ${
                      active
                        ? "border-foreground bg-foreground text-primary-foreground"
                        : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                    <span className="ml-2 tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>

            {regionGroups.length > 1 && (
              <div
                className="flex flex-wrap items-center gap-2 text-[0.7rem] tracking-widest"
                data-testid="region-filter"
              >
                <span className="mr-1 text-muted-foreground">
                  {t(p.block("regionLabel", PAGE.regionLabel))}
                </span>
                {[{ key: "all", label: PAGE.filterAll }, ...regionGroups].map((g) => {
                  const active = region === g.key;
                  return (
                    <button
                      key={g.key}
                      onClick={() => {
                        setRegion(g.key);
                        setOpen(null);
                      }}
                      aria-pressed={active}
                      className={`px-3 py-1.5 border transition-colors ${
                        active
                          ? "border-foreground text-foreground"
                          : "border-border/60 text-muted-foreground hover:border-foreground hover:text-foreground"
                      }`}
                    >
                      {t(g.label)}
                    </button>
                  );
                })}
              </div>
            )}

            <p className="text-xs text-muted-foreground tabular-nums" data-testid="visible-count">
              {visible.length} {t(p.block("countSuffix", PAGE.countSuffix))}
            </p>
          </section>

          {visible.length === 0 ? (
            <section className="container-editorial pb-32">
              <p className="border border-border p-8 text-sm text-muted-foreground">
                {t(p.block("empty", PAGE.empty))}
              </p>
            </section>
          ) : (
            <section
              className="container-editorial pb-32 grid gap-px bg-border border border-border sm:grid-cols-2 lg:grid-cols-3"
              data-testid="publication-grid"
            >
              {visible.map((entry) => (
                <PublicationCard
                  key={entry.id}
                  entry={entry}
                  product={entry.productId ? (productById.get(entry.productId) ?? null) : null}
                  open={open === entry.id}
                  onToggle={() => setOpen(open === entry.id ? null : entry.id)}
                  text={p}
                  soldOutLabel={t(ui.buttons.soldOut)}
                  addToCartLabel={t(ui.buttons.addToCart)}
                  viewProductLabel={t(ui.buttons.viewProduct)}
                />
              ))}
            </section>
          )}
        </>
      )}
    </PageShell>
  );
}

type CardProps = {
  entry: PublicationEntry;
  product: ShopProduct | null;
  open: boolean;
  onToggle: () => void;
  text: ReturnType<typeof pageText>;
  soldOutLabel: string;
  addToCartLabel: string;
  viewProductLabel: string;
};

function PublicationCard({
  entry,
  product,
  open,
  onToggle,
  text,
  soldOutLabel,
  addToCartLabel,
  viewProductLabel,
}: CardProps) {
  const t = useT();
  const addItem = useCart((s) => s.addItem);

  const soldOut = product !== null && isSoldOut(product);
  const remaining = product ? remainingFor(product) : null;
  const low = !soldOut && remaining !== null && remaining > 0 && remaining <= LOW_STOCK_THRESHOLD;

  function handleAdd() {
    if (!product) return;
    // 刊物展賣的是書，所以這裡永遠是 goods/book。萬一有人把某一本的 product_id
    // 指到活動商品，加進購物車會產生一行沒有 sessionId 的 booking —— 結帳會拒收
    // 它，而客人看到的是一句籠統的失敗。寧可在這裡什麼都不做，讓他走商品頁選場次。
    if (product.productType === "event" || product.productType === "journey") return;
    const result = addItem(cartInputFor(product, 1));
    if (result === "added") toast.success(t(text.block("addedToast", PAGE.addedToast)));
    else if (result === "capped") toast.warning(t(text.block("cappedToast", PAGE.cappedToast)));
    else toast.error(t(text.block("soldOutToast", PAGE.soldOutToast)));
  }

  return (
    <article
      id={entry.slug}
      data-testid="publication-card"
      data-slug={entry.slug}
      data-purchasable={product !== null && !soldOut ? "yes" : "no"}
      className="bg-background flex flex-col scroll-mt-24"
    >
      <div className="aspect-[4/3] overflow-hidden bg-muted">
        <img
          src={imageFor(entry.coverImageKey, bookstoreImg)}
          alt={t(entry.title)}
          loading="lazy"
          className={`h-full w-full object-contain ${soldOut ? "opacity-60" : ""}`}
        />
      </div>

      <div className="flex flex-1 flex-col p-7 md:p-8">
        <p className="eyebrow text-2xl">{entry.region || t(SHEET_LABELS[entry.sheet])}</p>
        <h2 className="font-serif text-xl mt-3 leading-snug">{t(entry.title)}</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="opacity-70">{t(text.block("publisherLabel", PAGE.publisherLabel))}</span>{" "}
          {t(entry.publisher)}
        </p>
        {entry.issues && (
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="opacity-70">{t(text.block("issuesLabel", PAGE.issuesLabel))}</span>{" "}
            {entry.issues}
          </p>
        )}

        <button
          onClick={onToggle}
          aria-expanded={open}
          className="mt-5 self-start text-xs tracking-widest text-clay hover-underline"
        >
          {t(text.block("readMore", PAGE.readMore))} {open ? "−" : "+"}
        </button>

        {open && (
          <div className="mt-4 border-l-2 border-clay/40 pl-5">
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {t(entry.intro)}
            </p>
            {entry.externalUrl && (
              <a
                href={entry.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-block text-xs tracking-widest text-clay hover-underline"
              >
                {t(text.block("visitSite", PAGE.visitSite))} →
              </a>
            )}
          </div>
        )}

        <div className="mt-auto pt-6">
          {product === null ? (
            <StockBadge>{t(text.block("displayOnly", PAGE.displayOnly))}</StockBadge>
          ) : (
            <>
              <PriceTag price={product.price} compareAtPrice={product.compareAtPrice} />
              {low && (
                <div className="mt-3">
                  <StockBadge>
                    {t(text.block("lowStock", PAGE.lowStock))} {remaining}{" "}
                    {t(text.block("lowStockUnit", PAGE.lowStockUnit))}
                  </StockBadge>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={soldOut}
                  data-testid="add-to-cart"
                  className="border border-foreground bg-foreground px-5 py-2.5 text-xs tracking-widest text-primary-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100"
                >
                  {soldOut ? soldOutLabel : addToCartLabel}
                </button>
                <Link
                  to="/shop/$slug"
                  params={{ slug: product.slug }}
                  className="text-xs tracking-widest text-muted-foreground hover-underline hover:text-foreground"
                >
                  {viewProductLabel}
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
