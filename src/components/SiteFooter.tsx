import { Link } from "@tanstack/react-router";
import { useT } from "@/i18n/LanguageContext";
import { UI, SITE_INFO, CONTACT_EMAIL, CONTACT_PHONES, SITE_URL, SOCIAL } from "@/i18n/strings";

export function SiteFooter() {
  const t = useT();
  return (
    <footer className="mt-32 border-t border-border/60 bg-[oklch(0.96_0.014_82)]/60">
      <div className="container-editorial py-16 grid gap-12 md:grid-cols-4">
        <div className="md:col-span-2">
          <h3 className="font-serif text-2xl">{t(UI.brand)}</h3>
          <p className="eyebrow mt-2 text-[0.6rem]">{t(UI.brandSub)}</p>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground max-w-sm">
            {t(SITE_INFO.shortDesc)}
          </p>
        </div>

        <div className="text-sm leading-relaxed">
          <p className="eyebrow mb-4">{t(UI.footer.visit)}</p>
          <p>{t(SITE_INFO.address)}</p>
          <p className="text-muted-foreground mt-1">{t(SITE_INFO.city)}</p>
          <p className="mt-3">{t(SITE_INFO.hours)}</p>
          <p className="text-muted-foreground">{t(UI.footer.everyday)}</p>
        </div>

        <div className="text-sm leading-relaxed">
          <p className="eyebrow mb-4">{t(UI.footer.contact)}</p>
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover-underline break-all">
            {CONTACT_EMAIL}
          </a>
          <div className="mt-2 space-y-1">
            {CONTACT_PHONES.map((p) => (
              <a key={p.tel} href={`tel:${p.tel}`} className="block hover-underline text-muted-foreground">
                {p.display}
              </a>
            ))}
          </div>
          <a
            href={SITE_URL}
            target="_blank"
            rel="noreferrer"
            className="block mt-3 text-muted-foreground hover-underline"
          >
            intervalbooks.tw
          </a>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            {SOCIAL.instagram && (
              <a href={SOCIAL.instagram} target="_blank" rel="noreferrer" className="hover-underline">
                Instagram
              </a>
            )}
            {SOCIAL.facebook && (
              <a href={SOCIAL.facebook} target="_blank" rel="noreferrer" className="hover-underline">
                Facebook
              </a>
            )}
            {SOCIAL.line && (
              <a href={SOCIAL.line} target="_blank" rel="noreferrer" className="hover-underline">
                LINE
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-border/60">
        <div className="container-editorial flex flex-col md:flex-row gap-3 md:items-center md:justify-between py-6 text-xs text-muted-foreground">
          <p>© {new Date().getFullYear()} {t(UI.footer.rights)}</p>
          <div className="flex gap-5">
            <Link to="/curation" className="hover-underline">
              {t(UI.nav.curation)}
            </Link>
            <Link to="/privacy" className="hover-underline">
              {t(UI.nav.privacy)}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
