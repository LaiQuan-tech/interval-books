import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchCuratedThemes, fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";
import { imageFor } from "@/lib/images";
import curatedImg from "@/assets/curated-objects.jpg";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "主理人的選品 Curated｜小時光書店 Interval Books",
    en: "Curated｜Interval Books",
    ja: "店主の選品｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "三個主題櫥窗：地方風土、器物與陶、茶與日常。展示型呈現，請至店或來信詢問。",
    en: "Three themed windows — place, vessels and clay, tea and daily life. A display, not a shop. Visit us or write to enquire.",
    ja: "三つのテーマの窓辺：土地の風土、器と陶、茶と日常。展示としてのご紹介です。店頭またはメールでお問い合わせください。",
  },
  eyebrowSuffix: { zh: "主理人的選品", en: "Curated", ja: "店主の選品" },
  title: { zh: "主理人的選品", en: "The Owner's Curated Window", ja: "店主の選品" },
  intro: {
    zh: "我們以「主題櫥窗」呈現選物，而非商品清單。每一件物，都是一段被留下來的時間。",
    en: "We arrange the selection as themed windows, not as a catalogue. Each piece holds a quiet stretch of time.",
    ja: "商品リストではなく、テーマの窓辺として並べています。一品一品が、留まった時間そのもの。",
  },
  windowLabel: { zh: "Window", en: "Window", ja: "Window" },
  askPurchase: { zh: "詢問與選購", en: "Ask & purchase", ja: "お問合せ・お求め" },
};

export const Route = createFileRoute("/curated")({
  loader: async () => {
    const [page, curatedThemes] = await Promise.all([fetchPage("curated"), fetchCuratedThemes()]);
    return { page, curatedThemes };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:image", content: imageFor(loaderData?.page?.ogImageKey, curatedImg) },
      ],
    };
  },
  component: Curated,
});

function Curated() {
  const t = useT();
  const { page, curatedThemes } = Route.useLoaderData();
  const p = pageText(page);
  const { ui, contactEmail, social } = useSiteContent();

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: imageFor(page?.ogImageKey, curatedImg),
  });
  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Curated", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className="container-editorial pb-24 space-y-32">
        {curatedThemes.map((theme, i) => (
          <div key={theme.id}>
            <div className="grid md:grid-cols-12 gap-10 items-end mb-12">
              <div className="md:col-span-5">
                <p className="eyebrow text-2xl">
                  {t(p.block("windowLabel", PAGE.windowLabel))} {String(i + 1).padStart(2, "0")}
                </p>
                <h2 className="display mt-4 text-4xl md:text-5xl">{t(theme.title)}</h2>
              </div>
              <p className="md:col-span-7 text-base leading-relaxed text-muted-foreground md:pb-2">
                {t(theme.description)}
              </p>
            </div>

            <div className="grid gap-px bg-border border border-border sm:grid-cols-2 lg:grid-cols-3">
              {theme.items.map((item, idx) => (
                <article key={idx} className="bg-background p-7 md:p-8 flex flex-col">
                  <p className="text-[0.65rem] tracking-widest text-muted-foreground">
                    {String(idx + 1).padStart(2, "0")}
                  </p>
                  <h3 className="font-serif text-xl mt-3 leading-snug">{t(item.name)}</h3>
                  <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                    {t(item.note)}
                  </p>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 flex flex-wrap gap-4 text-xs tracking-widest items-center">
          <span className="text-muted-foreground mr-4">
            {t(p.block("askPurchase", PAGE.askPurchase))}
          </span>
          <a
            className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            href={`mailto:${contactEmail}`}
          >
            {t(ui.buttons.emailUs)}
          </a>
          <a
            className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            href={social.line}
            target="_blank"
            rel="noreferrer"
          >
            {t(ui.buttons.line)}
          </a>
          <span className="text-clay">{t(ui.buttons.inStore)}</span>
        </div>
      </section>
    </PageShell>
  );
}
