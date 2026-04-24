import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { news } from "@/data/site";

export const Route = createFileRoute("/news")({
  head: () => ({
    meta: [
      { title: "最新消息｜小時光書店" },
      { name: "description", content: "公告、展覽、活動與策旅的第一手消息。" },
      { property: "og:title", content: "最新消息｜小時光書店" },
      { property: "og:description", content: "公告、展覽與活動更新。" },
    ],
  }),
  component: News,
});

function News() {
  return (
    <PageShell>
      <PageHeader eyebrow="News  ／  最新消息" title="店裡最近發生的事" />

      <section className="container-editorial pb-32">
        <div className="border-t border-border">
          {news.map((n) => (
            <article key={n.title} className="grid md:grid-cols-12 gap-6 py-10 border-b border-border">
              <p className="md:col-span-2 text-xs tracking-widest text-muted-foreground">{n.date}</p>
              <div className="md:col-span-10">
                <h3 className="font-serif text-2xl leading-snug">{n.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-foreground/75 max-w-2xl">{n.body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </PageShell>
  );
}
