import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { UI, CONTACT_EMAIL, SOCIAL } from "@/i18n/strings";
import { curatedThemes } from "@/data/content";
import curatedImg from "@/assets/curated-objects.jpg";

export const Route = createFileRoute("/curated")({
  head: () => ({
    meta: [
      { title: "主理人的選品 Curated｜小時光書店 Interval Books" },
      { name: "description", content: "三個主題櫥窗：地方風土、器物與陶、茶與日常。展示型呈現，請至店或來信詢問。" },
      { property: "og:title", content: "主理人的選品｜小時光書店" },
      { property: "og:description", content: "以櫥窗，而非貨架。" },
      { property: "og:image", content: curatedImg },
    ],
  }),
  component: Curated,
});

const PAGE = {
  title: { zh: "主理人的選品", en: "The Owner's Curated Window", ja: "店主の選品" },
  intro: {
    zh: "我們以「主題櫥窗」呈現選物，而非商品清單。每一件物，都是一段被留下來的時間。",
    en: "We arrange the selection as themed windows, not as a catalogue. Each piece holds a quiet stretch of time.",
    ja: "商品リストではなく、テーマの窓辺として並べています。一品一品が、留まった時間そのもの。",
  },
};

function Curated() {
  const t = useT();
  return (
    <PageShell>
      <PageHeader
        eyebrow={`Curated  ／  ${t(UI.nav.curated)}`}
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-24 space-y-32">
        {curatedThemes.map((theme, i) => (
          <div key={theme.id}>
            <div className="grid md:grid-cols-12 gap-10 items-end mb-12">
              <div className="md:col-span-5">
                <p className="eyebrow">Window {String(i + 1).padStart(2, "0")}</p>
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
                  <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{t(item.note)}</p>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 flex flex-wrap gap-4 text-xs tracking-widest items-center">
          <span className="text-muted-foreground mr-4">
            {t({ zh: "詢問與選購", en: "Ask & purchase", ja: "お問合せ・お求め" })}
          </span>
          <a className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors" href={`mailto:${CONTACT_EMAIL}`}>
            {t(UI.buttons.emailUs)}
          </a>
          <a className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors" href={SOCIAL.line} target="_blank" rel="noreferrer">
            {t(UI.buttons.line)}
          </a>
          <span className="text-clay">{t(UI.buttons.inStore)}</span>
        </div>
      </section>
    </PageShell>
  );
}
