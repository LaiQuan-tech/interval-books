import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import type { PageListEntry } from "@/lib/cms";
import { imageFor } from "@/lib/images";
import interiorImg from "@/assets/bookstore-interior.jpg";
import curatedImg from "@/assets/curated-objects.jpg";
import exhibitionImg from "@/assets/exhibition-corner.jpg";

export const Route = createFileRoute("/about")({
  loader: async () => ({ page: await fetchPage("about") }),
  head: ({ loaderData }) => {
    const page = loaderData?.page ?? null;
    const p = pageText(page);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:image", content: imageFor(page?.ogImageKey, interiorImg) },
      ],
    };
  },
  component: About,
});

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "關於 About｜小時光書店 Interval Books",
    en: "About｜Interval Books",
    ja: "について｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。",
    en: "We are Interval Books, tucked inside Huashan — birdsong, the scent of tea and paper, and the warmth of small encounters.",
    ja: "華山の小時光書店です。鳥のさえずり、茶と本の香り、ひとのぬくもりが交わる場。",
  },
  eyebrowSuffix: { zh: "關於", en: "About", ja: "について" },
  title: {
    zh: "在華山的一段安靜時光",
    en: "A quiet interval in Huashan",
    ja: "華山の、しずかな小さき時間",
  },
  intro: {
    zh: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。",
    en: "We are Interval Books, tucked inside Huashan — birdsong, the scent of tea and paper, and the warmth of small encounters.",
    ja: "華山の小時光書店です。鳥のさえずり、茶と本の香り、ひとのぬくもりが交わる場。",
  },
  story: {
    zh: "從一櫃書、一張長桌開始，我們慢慢有了陶藝家的器物、地方夥伴的選物、與每月一場讀書會。書店並不大，但它是我們對於「閱讀」的長時間練習——讓書頁與生活，能彼此呼吸。",
    en: "We began with a single shelf and a long table. Then came the ceramicists' vessels, the local partners' selections, and a monthly reading circle. The shop is small, but it is our long practice of reading — letting page and life breathe together.",
    ja: "一棚の本と一脚の長机から始まりました。やがて陶芸家の器、地方の作り手の品、月に一度の読書会が加わりました。小さな店ですが、本と暮らしがともに呼吸できる場をめざす、長い練習なのです。",
  },
  workTitle: { zh: "我們做的事", en: "What we do", ja: "わたしたちのしごと" },
  spaceTitle: { zh: "空間特色", en: "Inside the space", ja: "空間" },
};

const WORK_FALLBACK: PageListEntry[] = [
  {
    label: { zh: "風土誌策展", en: "Terroir Curation", ja: "風土誌キュレーション" },
    note: {
      zh: "以地方為線索，策劃書展、選物與內容。",
      en: "Place as the thread for book shows, objects, and content.",
      ja: "土地を糸口に、書展・選品・コンテンツを編む。",
    },
    imageKey: null,
  },
  {
    label: { zh: "活動與讀書會", en: "Events & Reading Circles", ja: "イベントと読書会" },
    note: {
      zh: "讀書會、講座、工作坊、身心靈活動。",
      en: "Reading circles, talks, workshops, and healing practice.",
      ja: "読書会、トーク、ワークショップ、ヒーリング。",
    },
    imageKey: null,
  },
  {
    label: { zh: "策旅與合作共創", en: "Journeys & Co-creation", ja: "旅と共創" },
    note: {
      zh: "與在地夥伴設計風土主題旅程與品牌共創。",
      en: "Place-rooted journeys and brand co-creation with local partners.",
      ja: "地のパートナーと風土の旅、ブランド共創を設計します。",
    },
    imageKey: null,
  },
];

const SPACE_FALLBACK: PageListEntry[] = [
  { label: { zh: "書", en: "Books", ja: "本" }, note: null, imageKey: "bookstore-interior.jpg" },
  { label: { zh: "選品", en: "Objects", ja: "選品" }, note: null, imageKey: "curated-objects.jpg" },
  { label: { zh: "策展", en: "Exhibitions", ja: "展覧" }, note: null, imageKey: "exhibition-corner.jpg" },
];

/** Positional safety net for SPACE_FALLBACK's bundled images, keyed by list order. */
const SPACE_FALLBACK_IMAGES = [interiorImg, curatedImg, exhibitionImg];

function About() {
  const t = useT();
  const { page } = Route.useLoaderData();
  const p = pageText(page);
  const workList = p.rows("work", WORK_FALLBACK);
  const spaceList = p.rows("space", SPACE_FALLBACK);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: imageFor(page?.ogImageKey, interiorImg),
  });

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "About", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className="container-editorial pb-24 grid md:grid-cols-2 gap-12 items-center">
        <div className="aspect-[4/5] overflow-hidden bg-muted">
          <img src={interiorImg} alt={t(p.title(PAGE.title))} className="h-full w-full object-cover" loading="lazy" />
        </div>
        <p className="text-base md:text-lg leading-loose text-foreground/80">{t(p.block("story", PAGE.story))}</p>
      </section>

      <section className="container-editorial pb-24">
        <h2 className="display text-3xl md:text-4xl border-t border-border pt-12">{t(p.block("workTitle", PAGE.workTitle))}</h2>
        <div className="mt-12 grid gap-px bg-border border border-border md:grid-cols-3">
          {workList.map((w, i) => (
            <article key={i} className="bg-background p-8 md:p-10">
              <p className="text-[0.65rem] tracking-widest text-muted-foreground">
                {String(i + 1).padStart(2, "0")}
              </p>
              <h3 className="display mt-3 text-2xl">{t(w.label)}</h3>
              <p className="mt-4 text-sm leading-relaxed text-foreground/75">{t(w.note ?? { zh: "", en: "", ja: "" })}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container-editorial pb-32">
        <p className="eyebrow text-2xl border-t border-border pt-12">
          {t(p.block("spaceTitle", PAGE.spaceTitle))}
        </p>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {spaceList.map((s, i) => (
            <figure key={i} className="space-y-4">
              <div className="aspect-[4/5] overflow-hidden bg-muted">
                <img
                  src={imageFor(s.imageKey, SPACE_FALLBACK_IMAGES[i] ?? interiorImg)}
                  alt={t(s.label)}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </div>
              <figcaption className="text-sm text-muted-foreground tracking-widest">— {t(s.label)}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </PageShell>
  );
}
