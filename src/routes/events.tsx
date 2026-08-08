import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { eyebrowOf, fetchEventCategories, fetchEvents, fetchPage, pageText } from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";
import { imageFor } from "@/lib/images";
import eventImg from "@/assets/event-reading.jpg";

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

export const Route = createFileRoute("/events")({
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
  const filterIds = ["all", ...categories.map((c) => c.id)];

  const [filter, setFilter] = useState<string>("all");
  const list = filter === "all" ? events : events.filter((e) => e.category === filter);

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Events", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className="container-editorial pb-12">
        <div className="mx-auto w-4/5 aspect-[3/4] md:aspect-[16/10] overflow-hidden bg-muted">
          <img src={heroSrc} alt={t(p.title(PAGE.title))} className="h-full w-full object-cover" loading="lazy" />
        </div>
      </section>

      <section className="container-editorial pb-12 flex flex-wrap gap-3 text-xs tracking-widest">
        {filterIds.map((f) => {
          const label = f === "all" ? t(p.block("filters.all", ALL)) : t(labelById.get(f) ?? { zh: f, en: f, ja: f });
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
            <p className="eyebrow text-2xl">{t(labelById.get(e.category) ?? { zh: e.category, en: e.category, ja: e.category })}</p>
            <h3 className="display mt-4 text-2xl md:text-3xl leading-snug">{t(e.title)}</h3>
            <p className="mt-4 text-sm text-muted-foreground">{e.date}</p>
            <p className="mt-4 text-sm leading-relaxed text-foreground/75 flex-1">{t(e.summary)}</p>
            <a
              href={e.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-8 inline-block self-start border border-foreground px-5 py-3 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base"
            >
              {t(ui.buttons.toEvent)}
            </a>
          </article>
        ))}
      </section>
    </PageShell>
  );
}
