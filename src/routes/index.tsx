import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import {
  fetchEvents,
  fetchExhibitions,
  fetchJourneys,
  fetchNews,
  fetchPage,
  pageText,
} from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";
import { imageFor } from "@/lib/images";
import heroImg from "@/assets/hero-mountain.jpg";
import storefrontImg from "@/assets/storefront.jpg";
import curatedImg from "@/assets/curated-objects.jpg";
import exhibitionImg from "@/assets/exhibition-corner.jpg";
import journeyImg from "@/assets/journey-mist.jpg";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE_META = {
  title: {
    zh: "小時光書店 Interval Books｜風土誌策展的閱讀與生活場域",
    en: "Interval Books｜A curated home for reading, terroir, and quiet life",
    ja: "小時光書店 Interval Books｜風土誌をキュレーションする読書と暮らしの場",
  },
};

const HERO = {
  eyebrow: {
    zh: "Interval Books  ／  Est.",
    en: "Interval Books  ／  Est.",
    ja: "Interval Books  ／  Est.",
  },
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

/** entryCards page_list_items fallback — position 0/1/2 map to /events, /journeys, /visit. */
const ENTRY_CARDS_FALLBACK = [
  { label: ENTRIES.events, note: ENTRIES.eventsDesc, imageKey: null },
  { label: ENTRIES.journeys, note: ENTRIES.journeysDesc, imageKey: null },
  { label: ENTRIES.visit, note: ENTRIES.visitDesc, imageKey: null },
];
const ENTRY_LINKS = ["/events", "/journeys", "/visit"] as const;

/** Latin section eyebrows — same string in all three languages, matching current output. */
const SECTION_EYEBROWS = {
  exhibitions: { zh: "Exhibitions", en: "Exhibitions", ja: "Exhibitions" },
  journeys: { zh: "Journeys", en: "Journeys", ja: "Journeys" },
  news: { zh: "News", en: "News", ja: "News" },
};

export const Route = createFileRoute("/")({
  loader: async () => {
    const [page, events, exhibitions, journeys, news] = await Promise.all([
      fetchPage("index"),
      fetchEvents(),
      fetchExhibitions(),
      fetchJourneys(),
      fetchNews(),
    ]);
    return { page, events, exhibitions, journeys, news };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, heroImg);
    return {
      meta: [
        { title: p.metaTitle(PAGE_META.title).zh },
        { name: "description", content: p.metaDescription(HERO.intro).zh },
        { property: "og:title", content: p.ogTitle(HERO.titleSub).zh },
        { property: "og:description", content: p.metaDescription(HERO.intro).zh },
        { property: "og:image", content: ogImg },
        { name: "twitter:image", content: ogImg },
      ],
    };
  },
  component: Index,
});

function Index() {
  const t = useT();
  const { page, events, exhibitions, journeys, news } = Route.useLoaderData();
  const p = pageText(page);
  const { ui, site, map } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, heroImg);

  useDocumentMeta({
    title: p.metaTitle(PAGE_META.title),
    description: p.metaDescription(HERO.intro),
    ogTitle: p.ogTitle(HERO.titleSub),
    ogImage: heroSrc,
  });

  return (
    <PageShell>
      {/* Hero */}
      <section className="container-editorial pt-16 md:pt-24 pb-20">
        <div className="grid lg:grid-cols-12 gap-10 lg:gap-16 items-end">
          <div className="lg:col-span-6">
            <p className="eyebrow text-2xl">{t(p.block("hero.eyebrow", HERO.eyebrow))}</p>
            <h1 className="display mt-6 text-5xl md:text-7xl lg:text-[5.5rem]">
              {t(p.block("hero.titleMain", HERO.titleMain))}
              <span className="block text-2xl md:text-3xl mt-6 text-muted-foreground font-light">
                {t(p.block("hero.titleSub", HERO.titleSub))}
              </span>
            </h1>
            <p className="mt-10 max-w-lg text-base md:text-lg leading-relaxed text-foreground/75">
              {t(p.block("hero.intro", HERO.intro))}
            </p>
            <div className="rule mt-10" />
            <p className="mt-8 max-w-lg text-sm leading-relaxed text-muted-foreground italic">
              {t(site.shortDesc)}
            </p>
          </div>
          <div className="lg:col-span-6">
            <div className="relative aspect-[4/3] overflow-hidden bg-muted">
              <img
                src={heroSrc}
                alt={t(p.block("hero.titleMain", HERO.titleMain))}
                className="absolute inset-0 h-full w-full object-cover"
                width={1536}
                height={1920}
              />
            </div>
          </div>
        </div>

        {/* 三入口卡片 */}
        <div className="mt-20 grid gap-px bg-border md:grid-cols-3 border border-border">
          {p.rows("entryCards", ENTRY_CARDS_FALLBACK).map((card, i) => (
            <Link
              key={ENTRY_LINKS[i] ?? "/events"}
              to={ENTRY_LINKS[i] ?? "/events"}
              className="group bg-background p-8 md:p-10 transition-colors hover:bg-[oklch(0.96_0.014_82)]"
            >
              <p className="eyebrow text-2xl">{t(p.block("entries.explore", ENTRIES.explore))}</p>
              <h3 className="display mt-4 text-2xl">{t(card.label)}</h3>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                {card.note ? t(card.note) : ""}
              </p>
              <span className="mt-8 inline-block text-xs tracking-widest text-clay group-hover:text-foreground">
                —— {t(p.block("entries.goTo", ENTRIES.goTo))}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* 精選活動 */}
      <SectionHeader
        eyebrow={t(ui.sections.thisMonth)}
        title={t(ui.sections.featuredEvents)}
        link={{ to: "/events", label: t(ui.buttons.viewAll) }}
      />
      {/* ⚠️ 這裡連的是**站內**的 /events/$slug，不是 e.externalUrl。
          externalUrl 有 5 筆還是 https://example.com/event-N 的佔位符（0001 的種子
          資料），所以首頁曾經有三顆按鈕直接把客人送去 example.com。活動詳情頁
          存在之後，站內那一頁才是正確的目的地；外部售票連結留在詳情頁上，由那一頁
          自己決定要不要顯示。 */}
      <div className="container-editorial pb-20 grid gap-8 md:grid-cols-3">
        {events.slice(0, 3).map((e) => (
          <Link
            key={e.id}
            to="/events/$slug"
            params={{ slug: e.slug }}
            className="group flex flex-col border border-border bg-background/40 hover:border-foreground/40 transition-colors"
          >
            {/* ⚠️ 先判斷 imageKey 非空**再**呼叫 imageFor()。imageFor(key, fallback)
                永遠會回一張圖，順序反過來就是每一張卡片都長同一張不相干的照片。 */}
            {e.imageKey ? (
              <div className="aspect-[4/3] overflow-hidden">
                <img
                  src={imageFor(e.imageKey, storefrontImg)}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                />
              </div>
            ) : null}
            <div className="flex flex-1 flex-col p-6">
              <p className="eyebrow text-2xl">{e.category}</p>
              <h3 className="display mt-3 text-2xl leading-snug">{t(e.title)}</h3>
              <p className="mt-3 text-sm text-muted-foreground">{e.date}</p>
              <p className="mt-4 text-sm leading-relaxed text-foreground/75 flex-1">
                {t(e.summary)}
              </p>
              <span className="mt-6 inline-block tracking-widest text-clay group-hover:underline self-start text-base">
                {t(ui.buttons.viewEvent)} →
              </span>
            </div>
          </Link>
        ))}
      </div>

      {/* 精選展覽 */}
      <SectionHeader
        eyebrow={t(p.block("sections.exhibitionsEyebrow", SECTION_EYEBROWS.exhibitions))}
        title={t(ui.sections.featuredExhibitions)}
        link={{ to: "/exhibitions", label: t(ui.buttons.viewAll) }}
      />
      <div className="container-editorial pb-24 grid gap-10 md:grid-cols-2">
        {exhibitions.slice(0, 2).map((ex, i) => (
          <article key={ex.id} className="group">
            <div className="aspect-[5/4] overflow-hidden bg-muted">
              <img
                src={imageFor(ex.imageKey, i === 0 ? exhibitionImg : storefrontImg)}
                alt={t(ex.title)}
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.02]"
              />
            </div>
            <p className="eyebrow text-2xl mt-6">{ex.period}</p>
            <h3 className="display mt-3 text-3xl">{t(ex.title)}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(ex.summary)}</p>
            <Link
              to="/exhibitions"
              hash={ex.slug}
              className="mt-5 inline-block text-xs tracking-widest text-clay hover-underline"
            >
              {t(ui.buttons.toExhibition)} →
            </Link>
          </article>
        ))}
      </div>

      {/* 精選策旅 */}
      <SectionHeader
        eyebrow={t(p.block("sections.journeysEyebrow", SECTION_EYEBROWS.journeys))}
        title={t(ui.sections.featuredJourney)}
        link={{ to: "/journeys", label: t(ui.buttons.viewAll) }}
      />
      <div className="container-editorial pb-24">
        {journeys.slice(0, 1).map((j) => (
          <article key={j.id} className="grid md:grid-cols-2 gap-12 items-center">
            <div className="aspect-[4/3] overflow-hidden bg-muted">
              <img
                src={journeyImg}
                alt={t(j.title)}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </div>
            <div>
              <p className="eyebrow text-2xl">
                {t(j.days)} ／ {t(j.theme)}
              </p>
              <h3 className="display mt-4 text-4xl whitespace-pre-line">{t(j.title)}</h3>
              <p className="mt-5 text-base leading-relaxed text-foreground/75">{t(j.summary)}</p>
              <a
                href={j.externalUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-8 inline-block border border-foreground px-6 py-3 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base"
              >
                {t(ui.buttons.toJourney)}
              </a>
            </div>
          </article>
        ))}
      </div>

      {/* 主理人選品預告 */}
      <section className="container-editorial pb-24">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <p className="eyebrow text-2xl">{t(ui.nav.curated)}</p>
            <h2 className="display mt-5 md:text-5xl text-3xl font-mono text-left whitespace-pre-line">
              {t(p.block("entries.curatedTitle", ENTRIES.curatedTitle))}
            </h2>
            <p className="mt-6 max-w-md text-base leading-relaxed text-foreground/75 whitespace-pre-line">
              {t(p.block("entries.curatedBody", ENTRIES.curatedBody))}
            </p>
            <Link
              to="/curated"
              className="mt-8 inline-block tracking-widest text-clay hover-underline text-base"
            >
              {t(p.block("entries.curatedCta", ENTRIES.curatedCta))} →
            </Link>
          </div>
          <div className="aspect-[4/5] overflow-hidden bg-muted">
            <img
              src={curatedImg}
              alt={t(ui.nav.curated)}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </div>
        </div>
      </section>

      {/* 來店資訊 */}
      <section className="container-editorial pb-24">
        <div className="grid md:grid-cols-2 gap-12 items-stretch">
          <div className="aspect-[4/3] md:aspect-auto bg-muted">
            <iframe src={map.embed} className="h-full w-full border-0" loading="lazy" title="Map" />
          </div>
          <div className="flex flex-col justify-center">
            <p className="eyebrow text-2xl">{t(ui.nav.visit)}</p>
            <h2 className="display mt-5 text-3xl md:text-4xl">{t(site.address)}</h2>
            <p className="mt-6 text-base text-foreground/75">{t(site.hours)}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t(ui.footer.everyday)}</p>
            <div className="mt-8 flex flex-wrap gap-4 text-xs tracking-widest">
              <a
                href={map.link}
                target="_blank"
                rel="noreferrer"
                className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
              >
                {t(ui.buttons.navigate)}
              </a>
              <Link to="/visit" className="self-center text-clay hover-underline">
                {t(p.block("entries.visitFull", ENTRIES.visitFull))} →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* 最新消息 */}
      <SectionHeader
        eyebrow={t(p.block("sections.newsEyebrow", SECTION_EYEBROWS.news))}
        title={t(ui.sections.latestNews)}
        link={{ to: "/news", label: t(ui.buttons.viewAll) }}
      />
      <div className="container-editorial pb-24 grid gap-10 md:grid-cols-3">
        {news.slice(0, 3).map((n) => (
          <article key={n.id}>
            <p className="text-muted-foreground tracking-widest text-lg">{n.date}</p>
            <h3 className="font-serif text-xl mt-3 leading-snug whitespace-pre-line">
              {t(n.title)}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
              {t(n.summary)}
            </p>
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
        <Link
          to={link.to}
          className="text-xs tracking-widest text-clay hover-underline hidden md:inline-block"
        >
          {link.label} →
        </Link>
      )}
    </div>
  );
}
