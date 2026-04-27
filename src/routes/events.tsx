import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { UI } from "@/i18n/strings";
import { events, type EventCategory } from "@/data/content";

export const Route = createFileRoute("/events")({
  head: () => ({
    meta: [
      { title: "活動 Events｜小時光書店 Interval Books" },
      { name: "description", content: "讀書會、療癒生活節、策旅說明會、陶藝家展售、身心靈工作坊與好書交流——本頁為策展式彙整，每場活動皆有獨立網站。" },
      { property: "og:title", content: "活動 Events｜小時光書店" },
      { property: "og:description", content: "策展式活動彙整。" },
    ],
  }),
  component: Events,
});

const CATEGORY_LABEL: Record<EventCategory, { zh: string; en: string; ja: string }> = {
  讀書會: { zh: "讀書會", en: "Reading Circles", ja: "読書会" },
  療癒生活節: { zh: "療癒生活節", en: "Healing Festival", ja: "ヒーリング祭" },
  策旅說明會: { zh: "策旅說明會", en: "Journey Briefings", ja: "旅の説明会" },
  陶藝家展售: { zh: "陶藝家展售", en: "Ceramicist Showcases", ja: "陶芸家の展示販売" },
  身心靈工作坊: { zh: "身心靈工作坊", en: "Mind & Body Workshops", ja: "心身ワークショップ" },
  好書交流: { zh: "好書交流", en: "Book Exchange", ja: "本の交流" },
};

const ALL: { zh: string; en: string; ja: string } = { zh: "全部", en: "All", ja: "すべて" };

const PAGE_INTRO = {
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

const FILTERS: ("all" | EventCategory)[] = [
  "all",
  "讀書會",
  "療癒生活節",
  "策旅說明會",
  "陶藝家展售",
  "身心靈工作坊",
  "好書交流",
];

function Events() {
  const t = useT();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const list = filter === "all" ? events : events.filter((e) => e.category === filter);

  return (
    <PageShell>
      <PageHeader
        eyebrow={`Events  ／  ${t(UI.nav.events)}`}
        title={t(PAGE_INTRO.title)}
        intro={t(PAGE_INTRO.intro)}
      />

      <section className="container-editorial pb-12 flex flex-wrap gap-3 text-xs tracking-widest">
        {FILTERS.map((f) => {
          const label = f === "all" ? t(ALL) : t(CATEGORY_LABEL[f]);
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
            <p className="eyebrow">{t(CATEGORY_LABEL[e.category])}</p>
            <h3 className="display mt-4 text-2xl md:text-3xl leading-snug">{t(e.title)}</h3>
            <p className="mt-4 text-sm text-muted-foreground">{e.date}</p>
            <p className="mt-4 text-sm leading-relaxed text-foreground/75 flex-1">{t(e.summary)}</p>
            <a
              href={e.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-8 inline-block self-start border border-foreground px-5 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
            >
              {t(UI.buttons.toEvent)}
            </a>
          </article>
        ))}
      </section>
    </PageShell>
  );
}
