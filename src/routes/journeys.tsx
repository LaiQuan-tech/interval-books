import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { UI, CONTACT_EMAIL } from "@/i18n/strings";
import { journeys } from "@/data/content";
import journeyImg from "@/assets/journey-mist.jpg";

export const Route = createFileRoute("/journeys")({
  head: () => ({
    meta: [
      { title: "策旅 Journeys｜小時光書店 Interval Books" },
      { name: "description", content: "由書與土地共同寫成的深度旅程。每一趟策旅皆有獨立網站，本頁為彙整導流。" },
      { property: "og:title", content: "策旅 Journeys｜小時光書店" },
      { property: "og:description", content: "由書與土地共同寫成的深度旅程。" },
      { property: "og:image", content: journeyImg },
    ],
  }),
  component: Journeys,
});

const PAGE = {
  title: {
    zh: "讓土地，成為書的延伸",
    en: "Let the land be the book's extension",
    ja: "土地を、本の延長に",
  },
  intro: {
    zh: "每一趟策旅皆有獨立網站，本頁僅做彙整導流。請點選感興趣的旅程，前往該旅程的專屬頁面。",
    en: "Each journey has its own dedicated site. Choose one to read further.",
    ja: "各「旅」には専用サイトがあります。気になる旅へお進みください。",
  },
  collab: { zh: "策旅合作共創", en: "Journey co-creation", ja: "旅の共創" },
  collabBody: {
    zh: "若您是地方夥伴、職人、旅宿或品牌，歡迎與我們共創一段屬於風土的策旅。請以 Email 聯繫。",
    en: "If you're a local partner, maker, hotel, or brand, we'd love to co-create a journey rooted in place. Reach us by email.",
    ja: "地域のパートナー、作り手、宿、ブランドの方へ。風土に根ざした旅をともに育てましょう。メールでご連絡ください。",
  },
};

function Journeys() {
  const t = useT();
  useDocumentMeta({
    title: {
      zh: "策旅 Journeys｜小時光書店 Interval Books",
      en: "Journeys｜Interval Books",
      ja: "旅｜小時光書店 Interval Books",
    },
    description: {
      zh: "由書與土地共同寫成的深度旅程。每一趟策旅皆有獨立網站，本頁為彙整導流。",
      en: "Slow journeys co-written by books and the land. Each trip has its own site; this page gathers the threads.",
      ja: "本と土地が共に綴る、深い旅。各旅には専用サイトがあります。このページはその目次です。",
    },
    ogTitle: PAGE.title,
    ogImage: journeyImg,
  });
  return (
    <PageShell>
      <PageHeader
        eyebrow="Journeys  ／  策旅"
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-24 grid gap-12 md:grid-cols-3">
        {journeys.map((j) => (
          <article key={j.id} className="flex flex-col">
            <div className="aspect-[4/3] overflow-hidden bg-muted">
              <img src={journeyImg} alt={t(j.title)} loading="lazy" className="h-full w-full object-cover" />
            </div>
            <p className="eyebrow mt-6">{t(j.days)}  ／  {t(j.theme)}</p>
            <h3 className="display mt-3 text-2xl leading-snug">{t(j.title)}</h3>
            <p className="mt-4 text-sm leading-relaxed text-foreground/75 flex-1">{t(j.summary)}</p>
            <a
              href={j.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-block self-start text-xs tracking-widest text-clay hover-underline"
            >
              {t(UI.buttons.toJourney)}  →
            </a>
          </article>
        ))}
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 grid md:grid-cols-2 gap-10">
          <div>
            <p className="eyebrow">Co-create</p>
            <h2 className="display mt-4 text-3xl md:text-4xl">{t(PAGE.collab)}</h2>
          </div>
          <div>
            <p className="text-base leading-relaxed text-foreground/80">{t(PAGE.collabBody)}</p>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="mt-6 inline-block border border-foreground px-6 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
            >
              {CONTACT_EMAIL}
            </a>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
