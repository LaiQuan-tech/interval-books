import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { CONTACT_EMAIL, SITE_URL, SOCIAL } from "@/i18n/strings";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "聯絡 Contact｜小時光書店 Interval Books" },
      { name: "description", content: "Email、Instagram、Facebook、LINE——歡迎與我們聯繫。" },
      { property: "og:title", content: "聯絡｜小時光書店" },
      { property: "og:description", content: "Email、Instagram、Facebook、LINE。" },
    ],
  }),
  component: Contact,
});

const PAGE = {
  title: { zh: "請與我們聯繫", en: "Reach out", ja: "ご連絡ください" },
  intro: {
    zh: "Email 是最直接的方式，我們會親自回覆。",
    en: "Email is the most direct way to reach us — we'll reply personally.",
    ja: "メールが一番確実です。一通ずつお返事します。",
  },
  email: { zh: "Email", en: "Email", ja: "メール" },
  social: { zh: "社群", en: "Follow", ja: "フォロー" },
  site: { zh: "官方網站", en: "Website", ja: "公式サイト" },
};

function Contact() {
  const t = useT();
  useDocumentMeta({
    title: {
      zh: "聯絡 Contact｜小時光書店 Interval Books",
      en: "Contact｜Interval Books",
      ja: "お問合せ｜小時光書店 Interval Books",
    },
    description: {
      zh: "Email、Instagram、Facebook、LINE——歡迎與我們聯繫。",
      en: "Reach us via email, Instagram, Facebook, or LINE — we'd love to hear from you.",
      ja: "メール、Instagram、Facebook、LINE でお気軽にご連絡ください。",
    },
    ogTitle: PAGE.title,
  });
  return (
    <PageShell>
      <PageHeader
        eyebrow={`Contact  ／  ${t({ zh: "聯絡", en: "Contact", ja: "お問合せ" })}`}
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-32 grid gap-16 md:grid-cols-2 max-w-4xl">
        <div>
          <p className="eyebrow">{t(PAGE.email)}</p>
          <a href={`mailto:${CONTACT_EMAIL}`} className="display mt-4 block text-3xl hover-underline">
            {CONTACT_EMAIL}
          </a>
        </div>
        <div className="space-y-10">
          <div>
            <p className="eyebrow">{t(PAGE.site)}</p>
            <a href={SITE_URL} target="_blank" rel="noreferrer" className="mt-3 block text-base hover-underline">
              intervalbooks.tw
            </a>
          </div>
          <div>
            <p className="eyebrow">{t(PAGE.social)}</p>
            <ul className="mt-4 space-y-2 text-base">
              <li><a href={SOCIAL.instagram} target="_blank" rel="noreferrer" className="hover-underline">Instagram　@intervalbookstw</a></li>
              <li><a href={SOCIAL.facebook} target="_blank" rel="noreferrer" className="hover-underline text-muted-foreground">Facebook</a></li>
              <li><a href={SOCIAL.line} target="_blank" rel="noreferrer" className="hover-underline text-muted-foreground">LINE</a></li>
            </ul>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
