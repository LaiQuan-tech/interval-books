import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "@/components/PageShell";
import { events, exhibitions, journeys, news, VISIT } from "@/data/site";
import heroImg from "@/assets/hero-mountain.jpg";
import interiorImg from "@/assets/bookstore-interior.jpg";
import curatedImg from "@/assets/curated-objects.jpg";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "小時光書店｜風土誌策展的閱讀與生活場域" },
      { name: "description", content: "以書展策展為核心，串連地方選物、陶藝作品、讀書會與身心靈活動，延伸至深度策旅與合作提案。" },
      { property: "og:title", content: "小時光書店｜風土誌策展的閱讀與生活場域" },
      { property: "og:description", content: "以策展為核心的閱讀與生活場域。" },
      { property: "og:image", content: heroImg },
      { name: "twitter:image", content: heroImg },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <PageShell>
      {/* Hero */}
      <section className="container-editorial pt-16 md:pt-24 pb-20">
        <div className="grid lg:grid-cols-12 gap-10 lg:gap-16 items-end">
          <div className="lg:col-span-6">
            <p className="eyebrow">Hourlight Bookstore  ／  Est.</p>
            <h1 className="display mt-6 text-5xl md:text-7xl lg:text-[5.5rem]">
              小時光書店
              <span className="block text-2xl md:text-3xl mt-6 text-muted-foreground font-light">
                風土誌策展的閱讀與生活場域
              </span>
            </h1>
            <p className="mt-10 max-w-lg text-base md:text-lg leading-relaxed text-foreground/75">
              以書展策展為核心，串連地方選物、陶藝作品、讀書會與身心靈活動，延伸至深度策旅與合作提案。
            </p>
            <div className="rule mt-10" />
          </div>
          <div className="lg:col-span-6">
            <div className="relative aspect-[4/5] overflow-hidden bg-muted">
              <img
                src={heroImg}
                alt="小時光書店．風土書房一隅"
                className="absolute inset-0 h-full w-full object-cover"
                width={1536}
                height={1920}
              />
            </div>
          </div>
        </div>

        {/* 三入口卡片（非固定 CTA） */}
        <div className="mt-20 grid gap-px bg-border md:grid-cols-3 border border-border">
          {[
            { to: "/events" as const, label: "看活動", desc: "讀書會、講座、工作坊與身心靈活動。" },
            { to: "/exhibitions" as const, label: "看展覽", desc: "風土、文字、器物的策展現場。" },
            { to: "/curation" as const, label: "合作洽詢", desc: "為品牌、空間與機構共構策展。" },
          ].map((c) => (
            <Link
              key={c.to}
              to={c.to}
              className="group bg-background p-8 md:p-10 transition-colors hover:bg-[oklch(0.96_0.014_82)]"
            >
              <p className="eyebrow">Explore</p>
              <h3 className="display mt-4 text-2xl">{c.label}</h3>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{c.desc}</p>
              <span className="mt-8 inline-block text-xs tracking-widest text-clay group-hover:text-foreground">
                ——  前往
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* 本月精選．活動 */}
      <SectionHeader eyebrow="This Month  ／  本月精選" title="精選活動" link={{ to: "/events", label: "全部活動" }} />
      <div className="container-editorial pb-20 grid gap-10 md:grid-cols-3">
        {events.slice(0, 3).map((e) => (
          <article key={e.title} className="flex flex-col">
            <p className="eyebrow">{e.category}</p>
            <h3 className="display mt-3 text-2xl leading-snug">{e.title}</h3>
            <p className="mt-3 text-sm text-muted-foreground">{e.date}</p>
            <p className="mt-4 text-sm leading-relaxed text-foreground/75 flex-1">{e.blurb}</p>
            <a
              href={e.url}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-block text-xs tracking-widest text-clay hover-underline self-start"
            >
              前往活動網站  →
            </a>
          </article>
        ))}
      </div>

      {/* 精選展覽 */}
      <SectionHeader eyebrow="Exhibitions  ／  策展現場" title="精選展覽" link={{ to: "/exhibitions", label: "全部展覽" }} />
      <div className="container-editorial pb-24 grid gap-10 md:grid-cols-2">
        {exhibitions.slice(0, 2).map((ex) => (
          <article key={ex.slug} className="group">
            <div className="aspect-[5/4] overflow-hidden bg-muted">
              <img src={interiorImg} alt={ex.title} loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.02]" />
            </div>
            <p className="eyebrow mt-6">{ex.period}</p>
            <h3 className="display mt-3 text-3xl">{ex.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{ex.blurb}</p>
            <Link to="/exhibitions" hash={ex.slug} className="mt-5 inline-block text-xs tracking-widest text-clay hover-underline">
              看展覽詳情  →
            </Link>
          </article>
        ))}
      </div>

      {/* 精選策旅 */}
      <SectionHeader eyebrow="Journeys  ／  策旅" title="精選策旅" link={{ to: "/journeys", label: "全部策旅" }} />
      <div className="container-editorial pb-24">
        {journeys.slice(0, 1).map((j) => (
          <article key={j.title} className="grid md:grid-cols-2 gap-12 items-center">
            <div className="aspect-[4/3] overflow-hidden bg-muted">
              <img src={heroImg} alt={j.title} loading="lazy" className="h-full w-full object-cover" />
            </div>
            <div>
              <p className="eyebrow">{j.days}  ／  {j.theme}</p>
              <h3 className="display mt-4 text-4xl">{j.title}</h3>
              <p className="mt-5 text-base leading-relaxed text-foreground/75">{j.blurb}</p>
              <a href={j.url} target="_blank" rel="noreferrer" className="mt-8 inline-block border border-foreground px-6 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors">
                前往旅程網站
              </a>
            </div>
          </article>
        ))}
      </div>

      {/* 主理人選品預告 */}
      <section className="container-editorial pb-24">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <p className="eyebrow">Curated  ／  主理人的選品</p>
            <h2 className="display mt-5 text-4xl md:text-5xl">以櫥窗，<br/>而非貨架。</h2>
            <p className="mt-6 max-w-md text-base leading-relaxed text-foreground/75">
              三個主題、數十件物——地方風土、器物與陶、茶點小物。每一只都是被留下來的緩慢時間。
            </p>
            <Link to="/curated" className="mt-8 inline-block text-xs tracking-widest text-clay hover-underline">
              走進選品櫥窗  →
            </Link>
          </div>
          <div className="aspect-[4/5] overflow-hidden bg-muted">
            <img src={curatedImg} alt="主理人選品" loading="lazy" className="h-full w-full object-cover" />
          </div>
        </div>
      </section>

      {/* 來店資訊 */}
      <section className="container-editorial pb-24">
        <div className="grid md:grid-cols-2 gap-12 items-stretch">
          <div className="aspect-[4/3] md:aspect-auto bg-muted">
            <iframe
              src={VISIT.mapEmbed}
              className="h-full w-full border-0"
              loading="lazy"
              title="店址地圖"
            />
          </div>
          <div className="flex flex-col justify-center">
            <p className="eyebrow">Visit  ／  來店資訊</p>
            <h2 className="display mt-5 text-4xl">📍 {VISIT.address}</h2>
            <p className="mt-6 text-base text-foreground/75">🕒 {VISIT.hours}</p>
            <p className="mt-1 text-sm text-muted-foreground">{VISIT.closed}</p>
            <div className="mt-8 flex gap-6 text-xs tracking-widest">
              <a href={VISIT.mapLink} target="_blank" rel="noreferrer" className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors">一鍵導航</a>
              <Link to="/visit" className="self-center text-clay hover-underline">完整來訪資訊  →</Link>
            </div>
          </div>
        </div>
      </section>

      {/* 最新消息 */}
      <SectionHeader eyebrow="News  ／  最新消息" title="最新消息" link={{ to: "/news", label: "全部消息" }} />
      <div className="container-editorial pb-24 grid gap-10 md:grid-cols-3">
        {news.slice(0, 3).map((n) => (
          <article key={n.title}>
            <p className="text-xs text-muted-foreground tracking-widest">{n.date}</p>
            <h3 className="font-serif text-xl mt-3 leading-snug">{n.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{n.body}</p>
          </article>
        ))}
      </div>
    </PageShell>
  );
}

function SectionHeader({
  eyebrow,
  title,
  link,
}: {
  eyebrow: string;
  title: string;
  link?: { to: "/events" | "/exhibitions" | "/journeys" | "/news"; label: string };
}) {
  return (
    <div className="container-editorial pt-12 pb-10 flex items-end justify-between border-t border-border">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="display mt-3 text-3xl md:text-4xl">{title}</h2>
      </div>
      {link && (
        <Link to={link.to} className="text-xs tracking-widest text-clay hover-underline hidden md:inline-block">
          {link.label}  →
        </Link>
      )}
    </div>
  );
}
