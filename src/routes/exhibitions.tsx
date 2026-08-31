import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchExhibitions, fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import { imageFor } from "@/lib/images";
import exhibitionImg from "@/assets/exhibition-corner.jpg";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "展覽 Exhibitions｜小時光書店 Interval Books",
    en: "Exhibitions｜Interval Books",
    ja: "展覧｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "風土、文字、器物的策展現場——當期與下檔展覽彙整。",
    en: "A curated stage for terroir, words, and objects — current and upcoming exhibitions.",
    ja: "風土、ことば、器のキュレーション現場。開催中・予定の展覧をご紹介します。",
  },
  eyebrowSuffix: { zh: "展覽", en: "展覽", ja: "展覽" },
  title: {
    zh: "在書頁與展牆之間",
    en: "Between page and wall",
    ja: "頁と壁のあいだに",
  },
  intro: {
    zh: "我們以小型策展的節奏經營展覽，每一檔展覽都嘗試讓文字、影像與器物對話。",
    en: "We work in the rhythm of small curation — letting words, images, and objects speak together.",
    ja: "小さなキュレーションのリズムで、言葉、像、器がともに語り合う場をつくります。",
  },
  details: { zh: "展覽細節", en: "Exhibition details", ja: "展覧の詳細" },
  visitNote: {
    zh: "參觀方式 ／ 營業時間內自由參觀，無需預約",
    en: "Visit anytime during opening hours, no reservation needed.",
    ja: "営業時間内は予約不要で自由にご覧いただけます。",
  },
};

export const Route = createFileRoute("/exhibitions")({
  loader: async () => {
    const [page, exhibitions] = await Promise.all([fetchPage("exhibitions"), fetchExhibitions()]);
    return { page, exhibitions };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:image", content: imageFor(loaderData?.page?.ogImageKey, exhibitionImg) },
      ],
    };
  },
  component: Exhibitions,
});

function Exhibitions() {
  const t = useT();
  const { page, exhibitions } = Route.useLoaderData();
  const p = pageText(page);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: imageFor(page?.ogImageKey, exhibitionImg),
  });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Exhibitions", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className="container-editorial pb-32 space-y-32">
        {exhibitions.map((ex, i) => (
          <article
            key={ex.id}
            id={ex.slug}
            className="grid md:grid-cols-12 gap-10 lg:gap-16 scroll-mt-24"
          >
            <div className={`md:col-span-7 ${i % 2 === 1 ? "md:order-2" : ""}`}>
              <div className="aspect-[4/3] overflow-hidden bg-muted">
                <img
                  src={imageFor(ex.imageKey, exhibitionImg)}
                  alt={t(ex.title)}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              </div>
            </div>
            <div className="md:col-span-5 flex flex-col justify-center">
              <p className="eyebrow text-2xl">{ex.period}</p>
              <h2 className="display mt-4 text-4xl md:text-5xl">{t(ex.title)}</h2>
              <p className="mt-3 text-sm text-muted-foreground">{t(ex.location)}</p>
              <div className="rule mt-6" />
              <p className="mt-6 text-base leading-relaxed text-foreground/80">{t(ex.summary)}</p>

              <button
                onClick={() => setOpen(open === ex.slug ? null : ex.slug)}
                className="mt-6 self-start text-xs tracking-widest text-clay hover-underline"
              >
                {t(p.block("details", PAGE.details))} {open === ex.slug ? "−" : "+"}
              </button>

              {open === ex.slug && (
                <div className="mt-5 border-l-2 border-clay/40 pl-5">
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {t(ex.description)}
                  </p>
                  <p className="mt-5 text-xs text-muted-foreground tracking-widest">
                    {t(p.block("visitNote", PAGE.visitNote))}
                  </p>
                </div>
              )}
            </div>
          </article>
        ))}
      </section>
    </PageShell>
  );
}
