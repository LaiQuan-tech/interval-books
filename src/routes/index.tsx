import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { UI, SITE_INFO, MAP } from "@/i18n/strings";
import { events, exhibitions, journeys, news } from "@/data/content";
import heroImg from "@/assets/hero-mountain.jpg";
import storefrontImg from "@/assets/storefront.jpg";
import curatedImg from "@/assets/curated-objects.jpg";
import exhibitionImg from "@/assets/exhibition-corner.jpg";
import journeyImg from "@/assets/journey-mist.jpg";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "小時光書店 Interval Books｜風土誌策展的閱讀與生活場域" },
      { name: "description", content: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。" },
      { property: "og:title", content: "小時光書店 Interval Books" },
      { property: "og:description", content: "風土誌策展的閱讀與生活場域。" },
      { property: "og:image", content: heroImg },
      { name: "twitter:image", content: heroImg },
    ],
  }),
  component: Index,
});

const HERO = {
  eyebrow: { zh: "Interval Books  ／  Est.", en: "Interval Books  ／  Est.", ja: "Interval Books  ／  Est." },
  titleMain: { zh: "小時光書店", en: "Interval Books", ja: "小時光書店" },
  titleSub: {
    zh: "留一點時間給真正重要的事",
    en: "Save a little time for what truly matters.",
    ja: "本当に大切なことに、少しの時間を。",
  },
  intro: {
    zh: "留一段屬於自己的＿＿＿小時光。",
    en: "Keep an interval that belongs only to you.",
    ja: "あなただけの小さな時間を、ひとつ。",
  },
};

const ENTRIES = {
  events: { zh: "看活動", en: "Events", ja: "イベント" },
  eventsDesc: {
    zh: "讀書會、講座、工作坊與身心靈活動。",
    en: "Reading circles, talks, workshops, and healing practice.",
    ja: "読書会、トーク、ワークショップ、ヒーリング。",
  },
  journeys: { zh: "看策旅", en: "Journeys", ja: "旅" },
  journeysDesc: {
    zh: "由書與土地共同寫成的深度旅程。",
    en: "Slow journeys co-written by books and the land.",
    ja: "本と土地が共に綴る、深い旅。",
  },
  visit: { zh: "來店資訊", en: "Visit", ja: "ご来店" },
  visitDesc: {
    zh: "華山，紅磚六合院，西7-3館。",
    en: "Huashan, Red Brick Courtyard, West 7-3.",
    ja: "華山、紅煉瓦六合院、西7-3館。",
  },
  explore: { zh: "Explore", en: "Explore", ja: "Explore" },
  goTo: { zh: "前往", en: "Enter", ja: "見る" },
  curatedTitle: {
    zh: "一本好書，一份心意，\n風帶不走了，都留在美好的人情連結裡。",
    en: "A window, not a shelf.",
    ja: "棚ではなく、窓辺に。",
  },
  curatedBody: {
    zh: "關於這片土地的故事\n地方風土、器物與陶、茶與日常。\n都是被留下來的緩慢時間。",
    en: "Three themes, dozens of pieces — place, vessels, tea. Each one a quiet pause held in form.",
    ja: "三つのテーマ、数十の品. 土地, 器, 茶. それぞれが、留め置かれた緩やかな時間。",
  },
  curatedCta: { zh: "走進選品櫥窗", en: "Enter the window", ja: "選品の窓辺へ" },
  visitFull: { zh: "完整來訪資訊", en: "Full visit info", ja: "ご案内" },
};

function Index() {
  const t = useT();
  useDocumentMeta({
    title: {
      zh: "小時光書店 Interval Books｜風土誌策展的閱讀與生活場域",
      en: "Interval Books｜A curated home for reading, terroir, and quiet life",
      ja: "小時光書店 Interval Books｜風土誌をキュレーションする読書と暮らしの場",
    },
    description: HERO.intro,
    ogTitle: HERO.titleSub,
    ogImage: heroImg,
  });

  return (
    <PageShell>
      {/* Hero */}
      <section className="container-editorial pt-16 md:pt-24 pb-20">
        <div className="grid lg:grid-cols-12 gap-10 lg:gap-16 items-end">
          <div className="lg:col-span-6">
            <p className="eyebrow text-2xl">{t(HERO.eyebrow)}</p>
            <h1 className="display mt-6 text-5xl md:text-7xl lg:text-[5.5rem]">
              {t(HERO.titleMain)}
              <span className="block text-2xl md:text-3xl mt-6 text-muted-foreground font-light">
                {t(HERO.titleSub)}
              </span>
            </h1>
            <p className="mt-10 max-w-lg text-base md:text-lg leading-relaxed text-foreground/75">
              {t(HERO.intro)}
            </p>
            <div className="rule mt-10" />
            <p className="mt-8 max-w-lg text-sm leading-relaxed text-muted-foreground italic">
              {t(SITE_INFO.shortDesc)}
            </p>
          </div>
          <div className="lg:col-span-6">
            <div className="relative aspect-[4/3] overflow-hidden bg-muted">
              <img
                src={heroImg}
                alt={t(HERO.titleMain)}
                className="absolute inset-0 h-full w-full object-cover"
                width={1536}
                height={1920}
              />
            </div>
          </div>
        </div>

        {/* 三入口卡片 */}
        <div className="mt-20 grid gap-px bg-border md:grid-cols-3 border border-border">
          {[
            { to: "/events" as const, label: t(ENTRIES.events), desc: t(ENTRIES.eventsDesc) },
            { to: "/journeys" as const, label: t(ENTRIES.journeys), desc: t(ENTRIES.journeysDesc) },
            { to: "/visit" as const, label: t(ENTRIES.visit), desc: t(ENTRIES.visitDesc) },
          ].map((c) => (
            <Link
              key={c.to}
              to={c.to}
              className="group bg-background p-8 md:p-10 transition-colors hover:bg-[oklch(0.96_0.014_82)]"
            >
              <p className="eyebrow text-2xl">{t(ENTRIES.explore)}</p>
              <h3 className="display mt-4 text-2xl">{c.label}</h3>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{c.desc}</p>
              <span className="mt-8 inline-block text-xs tracking-widest text-clay group-hover:text-foreground">
                ——  {t(ENTRIES.goTo)}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* 精選活動 */}
      <SectionHeader eyebrow={t(UI.sections.thisMonth)} title={t(UI.sections.featuredEvents)} link={{ to: "/events", label: t(UI.buttons.viewAll) }} />
      <div className="container-editorial pb-20 grid gap-10 md:grid-cols-3">
        {events.slice(0, 3).map((e) => (
          <article key={e.id} className="flex flex-col">
            <p className="eyebrow text-2xl">{e.category}</p>
            <h3 className="display mt-3 text-2xl leading-snug">{t(e.title)}</h3>
            <p className="mt-3 text-sm text-muted-foreground">{e.date}</p>
            <p className="mt-4 text-sm leading-relaxed text-foreground/75 flex-1">{t(e.summary)}</p>
            <a
              href={e.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-block tracking-widest text-clay hover-underline self-start text-base"
            >
              {t(UI.buttons.toEvent)}  →
            </a>
          </article>
        ))}
      </div>

      {/* 精選展覽 */}
      <SectionHeader eyebrow="Exhibitions" title={t(UI.sections.featuredExhibitions)} link={{ to: "/exhibitions", label: t(UI.buttons.viewAll) }} />
      <div className="container-editorial pb-24 grid gap-10 md:grid-cols-2">
        {exhibitions.slice(0, 2).map((ex, i) => (
          <article key={ex.id} className="group">
            <div className="aspect-[5/4] overflow-hidden bg-muted">
              <img src={i === 0 ? exhibitionImg : storefrontImg} alt={t(ex.title)} loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.02]" />
            </div>
            <p className="eyebrow text-2xl mt-6">{ex.period}</p>
            <h3 className="display mt-3 text-3xl">{t(ex.title)}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(ex.summary)}</p>
            <Link to="/exhibitions" hash={ex.slug} className="mt-5 inline-block text-xs tracking-widest text-clay hover-underline">
              {t(UI.buttons.toExhibition)}  →
            </Link>
          </article>
        ))}
      </div>

      {/* 精選策旅 */}
      <SectionHeader eyebrow="Journeys" title={t(UI.sections.featuredJourney)} link={{ to: "/journeys", label: t(UI.buttons.viewAll) }} />
      <div className="container-editorial pb-24">
        {journeys.slice(0, 1).map((j) => (
          <article key={j.id} className="grid md:grid-cols-2 gap-12 items-center">
            <div className="aspect-[4/3] overflow-hidden bg-muted">
              <img src={journeyImg} alt={t(j.title)} loading="lazy" className="h-full w-full object-cover" />
            </div>
            <div>
              <p className="eyebrow text-2xl">{t(j.days)}  ／  {t(j.theme)}</p>
              <h3 className="display mt-4 text-4xl whitespace-pre-line">{t(j.title)}</h3>
              <p className="mt-5 text-base leading-relaxed text-foreground/75">{t(j.summary)}</p>
              <a href={j.externalUrl} target="_blank" rel="noreferrer" className="mt-8 inline-block border border-foreground px-6 py-3 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base">
                {t(UI.buttons.toJourney)}
              </a>
            </div>
          </article>
        ))}
      </div>

      {/* 主理人選品預告 */}
      <section className="container-editorial pb-24">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <p className="eyebrow text-2xl">{t(UI.nav.curated)}</p>
            <h2 className="display mt-5 md:text-5xl text-3xl font-mono text-left whitespace-pre-line">{t(ENTRIES.curatedTitle)}</h2>
            <p className="mt-6 max-w-md text-base leading-relaxed text-foreground/75 whitespace-pre-line">
              {t(ENTRIES.curatedBody)}
            </p>
            <Link to="/curated" className="mt-8 inline-block tracking-widest text-clay hover-underline text-base">
              {t(ENTRIES.curatedCta)}  →
            </Link>
          </div>
          <div className="aspect-[4/5] overflow-hidden bg-muted">
            <img src={curatedImg} alt={t(UI.nav.curated)} loading="lazy" className="h-full w-full object-cover" />
          </div>
        </div>
      </section>

      {/* 來店資訊 */}
      <section className="container-editorial pb-24">
        <div className="grid md:grid-cols-2 gap-12 items-stretch">
          <div className="aspect-[4/3] md:aspect-auto bg-muted">
            <iframe
              src={MAP.embed}
              className="h-full w-full border-0"
              loading="lazy"
              title="Map"
            />
          </div>
          <div className="flex flex-col justify-center">
            <p className="eyebrow text-2xl">{t(UI.nav.visit)}</p>
            <h2 className="display mt-5 text-3xl md:text-4xl">{t(SITE_INFO.address)}</h2>
            <p className="mt-6 text-base text-foreground/75">{t(SITE_INFO.hours)}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t(UI.footer.everyday)}</p>
            <div className="mt-8 flex flex-wrap gap-4 text-xs tracking-widest">
              <a href={MAP.link} target="_blank" rel="noreferrer" className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors">
                {t(UI.buttons.navigate)}
              </a>
              <Link to="/visit" className="self-center text-clay hover-underline">
                {t(ENTRIES.visitFull)}  →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* 最新消息 */}
      <SectionHeader eyebrow="News" title={t(UI.sections.latestNews)} link={{ to: "/news", label: t(UI.buttons.viewAll) }} />
      <div className="container-editorial pb-24 grid gap-10 md:grid-cols-3">
        {news.slice(0, 3).map((n) => (
          <article key={n.id}>
            <p className="text-muted-foreground tracking-widest text-lg">{n.date}</p>
            <h3 className="font-serif text-xl mt-3 leading-snug whitespace-pre-line">{t(n.title)}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground whitespace-pre-line">{t(n.summary)}</p>
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
        <p className="eyebrow text-2xl">{eyebrow}</p>
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
