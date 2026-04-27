import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { news } from "@/data/content";

export const Route = createFileRoute("/news")({
  head: () => ({
    meta: [
      { title: "最新消息 News｜小時光書店 Interval Books" },
      { name: "description", content: "活動預告、營業調整與策旅消息。" },
      { property: "og:title", content: "最新消息｜小時光書店" },
      { property: "og:description", content: "活動預告、營業調整與策旅消息。" },
    ],
  }),
  component: News,
});

const PAGE = {
  title: { zh: "最新消息", en: "Latest News", ja: "お知らせ" },
  intro: {
    zh: "簡短的小通知與更新——展覽、活動、營業時間變動。",
    en: "Short notes and updates — exhibitions, events, and hours.",
    ja: "短いお知らせ。展覧、イベント、営業時間など。",
  },
};

function News() {
  const t = useT();
  return (
    <PageShell>
      <PageHeader
        eyebrow="News  ／  最新消息"
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-32 max-w-3xl">
        <ul className="divide-y divide-border border-y border-border">
          {news.map((n) => (
            <li key={n.id} className="py-10">
              <p className="text-xs text-muted-foreground tracking-widest">{n.date}</p>
              <h3 className="font-serif text-2xl mt-3 leading-snug">{t(n.title)}</h3>
              <p className="mt-4 text-sm leading-relaxed text-foreground/75">{t(n.summary)}</p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(n.description)}</p>
            </li>
          ))}
        </ul>
      </section>
    </PageShell>
  );
}
