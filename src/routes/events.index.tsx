import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { isPastEvent } from "@/lib/event-status";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { eyebrowOf, fetchEventCategories, fetchEvents, fetchPage, pageText } from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";
import { imageFor } from "@/lib/images";
import eventImg from "@/assets/event-reading.jpg";

/**
 * 活動列表頁。
 *
 * 🔴 檔名是 events.index.tsx，不是 events.tsx。flat routing 下 `events.tsx` 會變成
 *    /events 底下所有路由的 parent layout —— 它得渲染 <Outlet />，否則
 *    /events/$slug 就是一片空白。repo 自己的慣例已經給了答案：沒有 shop.tsx，
 *    只有 shop.index.tsx + shop.$slug.tsx。這一組照抄。
 */

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "活動 Events｜小時光書店 Interval Books",
    en: "Events｜Interval Books",
    ja: "イベント｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "讀書會、療癒生活節、策旅說明會、陶藝家展售、身心靈工作坊與好書交流——本頁為策展式彙整，每場活動皆有獨立網站。",
    en: "Reading circles, healing festivals, journey briefings, ceramicist showcases, somatic workshops, and book exchanges — a curated overview; each event has its own site.",
    ja: "読書会、ヒーリング・フェス、旅の説明会、陶芸家の展示販売、ソマティック・ワークショップ、本の交流。各イベントには専用サイトがあります。",
  },
  eyebrowSuffix: { zh: "活動", en: "Events", ja: "イベント" },
  title: {
    zh: "閱讀，是一種共同進行的生活",
    en: "Reading, a life held in common",
    ja: "読むことは、ともにある暮らし",
  },
  intro: {
    zh: "每一場活動都有獨立的網站。本頁僅作為策展式彙整，幫助你在書店發生的事情之間，找到屬於自己的節奏。",
    en: "Each event has its own site. This page is a curated overview — find your own rhythm among what unfolds in the bookshop.",
    ja: "各イベントには専用サイトがあります。このページはキュレーションされた目次として、書店で起きることのなかから、ご自身のリズムを見つけていただくためのものです。",
  },
};

/** "all" filter pill — a page_block on the events page. */
const ALL = { zh: "全部", en: "All", ja: "すべて" };
const PAST_LABEL = { zh: "已結束", en: "Past", ja: "終了" };
const PAST_BADGE = { zh: "已結束", en: "Ended", ja: "終了" };

/**
 * 「活動詳情」——  連到 /events/$slug。
 *
 * 走 p.block() 讓後台可以覆寫，與這一頁其他文案一致；PAGE 裡的這一份只是
 * 資料庫讀不到時的退路。
 */
const DETAIL = { zh: "活動詳情", en: "Event details", ja: "イベント詳細" };

export const Route = createFileRoute("/events/")({
  loader: async () => {
    const [page, events, categories] = await Promise.all([
      fetchPage("events"),
      fetchEvents(),
      fetchEventCategories(),
    ]);
    return { page, events, categories };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, eventImg);
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
  component: Events,
});

function Events() {
  const t = useT();
  const { page, events, categories } = Route.useLoaderData();
  const p = pageText(page);
  const { ui } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, eventImg);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: heroSrc,
  });

  const labelById = new Map(categories.map((c) => [c.id, c.label] as const));
  // 「已結束」不是一個 event_categories 的分類，是一個時間狀態，所以它是一個
  // 寫死的哨兵 id 而不是從 categories 來的。放在最後一格。
  const PAST_FILTER = "__past__";
  const filterIds = ["all", ...categories.map((c) => c.id), PAST_FILTER];

  const [filter, setFilter] = useState<string>("all");

  // 🔴 已結束的活動**只有在「已結束」那一格才找得到**。其餘每一格（含「全部」）
  //    都把它們排除掉 —— 「全部」的意思是「所有還在進行的活動」，不是「所有列」。
  //    辦過的活動留在站上是為了讓人看得到我們辦過什麼，不是為了讓人以為還能報名。
  const upcoming = events.filter((e) => !isPastEvent(e.isoDate));
  const past = events.filter((e) => isPastEvent(e.isoDate));
  const list =
    filter === PAST_FILTER
      ? past
      : filter === "all"
        ? upcoming
        : upcoming.filter((e) => e.category === filter);

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Events", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
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

      <section className="container-editorial pb-12 flex flex-wrap gap-3 text-xs tracking-widest">
        {filterIds.map((f) => {
          const label =
            f === "all"
              ? t(p.block("filters.all", ALL))
              : f === PAST_FILTER
                ? t(p.block("filters.past", PAST_LABEL))
                : t(labelById.get(f) ?? { zh: f, en: f, ja: f });
          const active = filter === f;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
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

      <section className="container-editorial pb-32 grid gap-px bg-border border border-border md:grid-cols-2">
        {list.map((e) => (
          <article key={e.id} className="bg-background p-8 md:p-10 flex flex-col">
            <div className="flex flex-wrap items-center gap-3">
              <p className="eyebrow text-2xl">
                {t(labelById.get(e.category) ?? { zh: e.category, en: e.category, ja: e.category })}
              </p>
              {/* 已結束要在卡片上看得出來 —— 只靠「它在另一個分頁底下」不夠：
                  分享出去的連結、從搜尋進來的人都不會看到那個分頁。 */}
              {isPastEvent(e.isoDate) ? (
                <span className="border border-border px-2 py-0.5 text-xs tracking-widest text-muted-foreground">
                  {t(p.block("filters.pastBadge", PAST_BADGE))}
                </span>
              ) : null}
            </div>
            <h3 className="display mt-4 text-2xl md:text-3xl leading-snug">{t(e.title)}</h3>
            <p className="mt-4 text-sm text-muted-foreground">{e.date}</p>
            <p className="mt-4 text-sm leading-relaxed text-foreground/75 flex-1">{t(e.summary)}</p>
            {/* 詳情頁擺在外部連結前面：這一則活動在**這個站上**的那一頁，才是
                我們自己說得清楚的地方。外部連結原樣留著 —— 主辦方的報名表單、
                售票頁通常都還在那裡。 */}
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                to="/events/$slug"
                params={{ slug: e.slug }}
                className="inline-block border border-foreground px-5 py-3 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base"
              >
                {t(p.block("detail", DETAIL))}
              </Link>
              <a
                href={e.externalUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm tracking-widest text-muted-foreground hover-underline hover:text-foreground transition-colors"
              >
                {t(ui.buttons.toEvent)}
              </a>
            </div>
          </article>
        ))}
      </section>
    </PageShell>
  );
}
