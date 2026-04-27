import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { CONTACT_EMAIL } from "@/i18n/strings";
import { collaborations } from "@/data/content";

export const Route = createFileRoute("/curation")({
  head: () => ({
    meta: [
      { title: "策展與合作 Curation｜小時光書店 Interval Books" },
      { name: "description", content: "療癒藝術節、空間策展、書店展售與品牌共創——以低調而精緻的方式，與夥伴共創。" },
      { property: "og:title", content: "策展與合作｜小時光書店" },
      { property: "og:description", content: "與夥伴共創一種有策展感的現場。" },
    ],
  }),
  component: Curation,
});

const PAGE = {
  title: {
    zh: "與夥伴，共構一段現場",
    en: "Co-creating a quiet stage",
    ja: "ともに、ひとつの現場を",
  },
  intro: {
    zh: "我們相信策展不只是擺放，而是讓人、物、空間，在一段時間裡彼此看見。",
    en: "Curation, to us, is not arrangement — it's letting people, objects, and space see one another for a while.",
    ja: "キュレーションとは並べることではなく、人と物と空間がしばらくのあいだ互いに見つめ合うこと。",
  },
  contact: {
    zh: "合作邀請請以 Email 聯繫，我們會親自回覆。",
    en: "For collaboration, please reach us by email — we'll reply personally.",
    ja: "ご相談はメールにて。一通ずつお返事いたします。",
  },
};

function Curation() {
  const t = useT();
  return (
    <PageShell>
      <PageHeader
        eyebrow="Curation  ／  策展與合作"
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-24 grid gap-px bg-border border border-border md:grid-cols-2">
        {collaborations.map((c, i) => (
          <article key={i} className="bg-background p-8 md:p-10">
            <p className="text-[0.65rem] tracking-widest text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </p>
            <h3 className="display mt-3 text-2xl">{t(c.title)}</h3>
            <p className="mt-4 text-sm leading-relaxed text-foreground/75">{t(c.desc)}</p>
          </article>
        ))}
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 max-w-2xl">
          <p className="eyebrow">Contact</p>
          <p className="mt-5 text-lg leading-relaxed text-foreground/80">{t(PAGE.contact)}</p>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="mt-8 inline-block border border-foreground px-6 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
          >
            {CONTACT_EMAIL}
          </a>
        </div>
      </section>
    </PageShell>
  );
}
