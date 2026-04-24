import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { events, type EventCategory } from "@/data/site";

export const Route = createFileRoute("/events")({
  head: () => ({
    meta: [
      { title: "活動｜小時光書店" },
      { name: "description", content: "讀書會、身心靈、講座、工作坊——本頁為策展式彙整，每場活動皆有獨立網站。" },
      { property: "og:title", content: "活動｜小時光書店" },
      { property: "og:description", content: "策展式活動彙整。" },
    ],
  }),
  component: Events,
});

const FILTERS: ("全部" | EventCategory)[] = ["全部", "讀書會", "身心靈", "講座", "工作坊"];

function Events() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("全部");
  const list = filter === "全部" ? events : events.filter((e) => e.category === filter);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Events  ／  活動"
        title="閱讀，是一種共同進行的生活"
        intro="每一場活動都有獨立的網站。本頁僅作為策展式彙整，幫助你在書店發生的事情之間，找到屬於自己的節奏。"
      />

      <section className="container-editorial pb-12 flex flex-wrap gap-3 text-xs tracking-widest">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 border transition-colors ${
              filter === f
                ? "border-foreground bg-foreground text-primary-foreground"
                : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
            }`}
          >
            {f}
          </button>
        ))}
      </section>

      <section className="container-editorial pb-32 grid gap-px bg-border border border-border md:grid-cols-2">
        {list.map((e) => (
          <article key={e.title} className="bg-background p-8 md:p-10 flex flex-col">
            <p className="eyebrow">{e.category}</p>
            <h3 className="display mt-4 text-2xl md:text-3xl leading-snug">{e.title}</h3>
            <p className="mt-4 text-sm text-muted-foreground">{e.date}</p>
            <p className="mt-4 text-sm leading-relaxed text-foreground/75 flex-1">{e.blurb}</p>
            <a
              href={e.url}
              target="_blank"
              rel="noreferrer"
              className="mt-8 inline-block self-start border border-foreground px-5 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
            >
              前往活動網站
            </a>
          </article>
        ))}
      </section>
    </PageShell>
  );
}
