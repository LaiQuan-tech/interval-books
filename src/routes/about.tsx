import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import interiorImg from "@/assets/bookstore-interior.jpg";
import curatedImg from "@/assets/curated-objects.jpg";
import exhibitionImg from "@/assets/exhibition-corner.jpg";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "關於 About｜小時光書店 Interval Books" },
      { name: "description", content: "小時光書店是位於華山的閱讀與生活場域，以風土誌策展為核心，連結書、選物、陶藝、茶與聚會。" },
      { property: "og:title", content: "關於｜小時光書店" },
      { property: "og:description", content: "華山裡的小時光書店：風土、書、器物、茶與聚會。" },
      { property: "og:image", content: interiorImg },
    ],
  }),
  component: About,
});

const PAGE = {
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
};

const WORK = [
  {
    title: { zh: "風土誌策展", en: "Terroir Curation", ja: "風土誌キュレーション" },
    desc: {
      zh: "以地方為線索，策劃書展、選物與內容。",
      en: "Place as the thread for book shows, objects, and content.",
      ja: "土地を糸口に、書展・選品・コンテンツを編む。",
    },
  },
  {
    title: { zh: "活動與讀書會", en: "Events & Reading Circles", ja: "イベントと読書会" },
    desc: {
      zh: "讀書會、講座、工作坊、身心靈活動。",
      en: "Reading circles, talks, workshops, and healing practice.",
      ja: "読書会、トーク、ワークショップ、ヒーリング。",
    },
  },
  {
    title: { zh: "策旅與合作共創", en: "Journeys & Co-creation", ja: "旅と共創" },
    desc: {
      zh: "與在地夥伴設計風土主題旅程與品牌共創。",
      en: "Place-rooted journeys and brand co-creation with local partners.",
      ja: "地のパートナーと風土の旅、ブランド共創を設計します。",
    },
  },
];

const SPACE = [
  { label: { zh: "書", en: "Books", ja: "本" }, img: interiorImg },
  { label: { zh: "選品", en: "Objects", ja: "選品" }, img: curatedImg },
  { label: { zh: "策展", en: "Exhibitions", ja: "展覧" }, img: exhibitionImg },
];

function About() {
  const t = useT();
  return (
    <PageShell>
      <PageHeader
        eyebrow={`About  ／  ${t({ zh: "關於", en: "About", ja: "について" })}`}
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-24 grid md:grid-cols-2 gap-12 items-center">
        <div className="aspect-[4/5] overflow-hidden bg-muted">
          <img src={interiorImg} alt={t(PAGE.title)} className="h-full w-full object-cover" loading="lazy" />
        </div>
        <p className="text-base md:text-lg leading-loose text-foreground/80">{t(PAGE.story)}</p>
      </section>

      <section className="container-editorial pb-24">
        <h2 className="display text-3xl md:text-4xl border-t border-border pt-12">{t(PAGE.workTitle)}</h2>
        <div className="mt-12 grid gap-px bg-border border border-border md:grid-cols-3">
          {WORK.map((w, i) => (
            <article key={i} className="bg-background p-8 md:p-10">
              <p className="text-[0.65rem] tracking-widest text-muted-foreground">
                {String(i + 1).padStart(2, "0")}
              </p>
              <h3 className="display mt-3 text-2xl">{t(w.title)}</h3>
              <p className="mt-4 text-sm leading-relaxed text-foreground/75">{t(w.desc)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container-editorial pb-32">
        <p className="eyebrow border-t border-border pt-12">
          {t({ zh: "空間特色", en: "Inside the space", ja: "空間" })}
        </p>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {SPACE.map((s, i) => (
            <figure key={i} className="space-y-4">
              <div className="aspect-[4/5] overflow-hidden bg-muted">
                <img src={s.img} alt={t(s.label)} className="h-full w-full object-cover" loading="lazy" />
              </div>
              <figcaption className="text-sm text-muted-foreground tracking-widest">— {t(s.label)}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </PageShell>
  );
}
