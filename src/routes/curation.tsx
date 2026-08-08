import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchCollaborations, fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "策展與合作 Curation｜小時光書店 Interval Books",
    en: "Curation & Collaboration｜Interval Books",
    ja: "キュレーションと協働｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "療癒藝術節、空間策展、書店展售與品牌共創——以低調而精緻的方式，與夥伴共創。",
    en: "Healing arts festivals, spatial curation, in-store exhibitions, and quiet brand collaborations — co-created with care.",
    ja: "ヒーリング・アートフェス、空間キュレーション、店内展示、ブランド共創。静かで丁寧な協働を。",
  },
  eyebrowSuffix: { zh: "策展與合作", en: "策展與合作", ja: "策展與合作" },
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
  contactEyebrow: { zh: "Contact", en: "Contact", ja: "Contact" },
  contact: {
    zh: "合作邀請請以 Email 聯繫，我們會親自回覆。",
    en: "For collaboration, please reach us by email — we'll reply personally.",
    ja: "ご相談はメールにて。一通ずつお返事いたします。",
  },
};

export const Route = createFileRoute("/curation")({
  loader: async () => {
    const [page, collaborations] = await Promise.all([
      fetchPage("curation"),
      fetchCollaborations(),
    ]);
    return { page, collaborations };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
      ],
    };
  },
  component: Curation,
});

function Curation() {
  const t = useT();
  const { page, collaborations } = Route.useLoaderData();
  const p = pageText(page);
  const { contactEmail } = useSiteContent();

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
  });

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Curation", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className="container-editorial pb-24 grid gap-px bg-border border border-border md:grid-cols-2">
        {collaborations.map((c, i) => (
          <article key={c.id} className="bg-background p-8 md:p-10">
            <p className="text-[0.65rem] tracking-widest text-muted-foreground">
              {String(i + 1).padStart(2, "0")}
            </p>
            <h3 className="display mt-3 text-2xl">{t(c.title)}</h3>
            <p className="mt-4 text-sm leading-relaxed text-foreground/75">{t(c.description)}</p>
          </article>
        ))}
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 max-w-2xl">
          <p className="eyebrow text-2xl">{t(p.block("contactEyebrow", PAGE.contactEyebrow))}</p>
          <p className="mt-5 text-lg leading-relaxed text-foreground/80">
            {t(p.block("contact", PAGE.contact))}
          </p>
          <a
            href={`mailto:${contactEmail}`}
            className="mt-8 inline-block border border-foreground px-6 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
          >
            {contactEmail}
          </a>
        </div>
      </section>
    </PageShell>
  );
}
