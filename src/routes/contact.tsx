import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "聯絡 Contact｜小時光書店 Interval Books",
    en: "Contact｜Interval Books",
    ja: "お問合せ｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "Email、Instagram、Facebook、LINE——歡迎與我們聯繫。",
    en: "Reach us via email, Instagram, Facebook, or LINE — we'd love to hear from you.",
    ja: "メール、Instagram、Facebook、LINE でお気軽にご連絡ください。",
  },
  eyebrowSuffix: { zh: "聯絡", en: "Contact", ja: "お問合せ" },
  title: { zh: "請與我們聯繫", en: "Reach out", ja: "ご連絡ください" },
  intro: {
    zh: "Email 是最直接的方式，我們會親自回覆。",
    en: "Email is the most direct way to reach us — we'll reply personally.",
    ja: "メールが一番確実です。一通ずつお返事します。",
  },
  email: { zh: "Email", en: "Email", ja: "メール" },
  phone: { zh: "電話", en: "Phone", ja: "お電話" },
  social: { zh: "社群", en: "Follow", ja: "フォロー" },
  site: { zh: "官方網站", en: "Website", ja: "公式サイト" },
};

export const Route = createFileRoute("/contact")({
  loader: async () => ({ page: await fetchPage("contact") }),
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
  component: Contact,
});

function Contact() {
  const t = useT();
  const { page } = Route.useLoaderData();
  const p = pageText(page);
  const { contactEmail, siteUrl, phones, social } = useSiteContent();

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
  });

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Contact", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className="container-editorial pb-32 grid gap-16 md:grid-cols-2 max-w-4xl">
        <div>
          <p className="eyebrow text-2xl">{t(p.block("email", PAGE.email))}</p>
          <a href={`mailto:${contactEmail}`} className="display mt-4 block text-2xl md:text-3xl hover-underline break-all">
            {contactEmail}
          </a>

          <p className="eyebrow text-2xl mt-10">{t(p.block("phone", PAGE.phone))}</p>
          <ul className="mt-4 space-y-2 text-lg">
            {phones.map((phone) => (
              <li key={phone.tel}>
                <a href={`tel:${phone.tel}`} className="font-serif hover-underline">
                  {phone.display}
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-10">
          <div>
            <p className="eyebrow text-2xl">{t(p.block("site", PAGE.site))}</p>
            <a href={siteUrl} target="_blank" rel="noreferrer" className="mt-3 block text-base hover-underline">
              {siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
          </div>
          <div>
            <p className="eyebrow text-2xl">{t(p.block("social", PAGE.social))}</p>
            <ul className="mt-4 space-y-2 text-base">
              <li><a href={social.instagram} target="_blank" rel="noreferrer" className="hover-underline">Instagram　@intervalbookstw</a></li>
              <li><a href={social.facebook} target="_blank" rel="noreferrer" className="hover-underline text-muted-foreground">Facebook</a></li>
              <li><a href={social.line} target="_blank" rel="noreferrer" className="hover-underline text-muted-foreground">LINE</a></li>
            </ul>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
