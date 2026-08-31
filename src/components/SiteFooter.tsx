import { Link } from "@tanstack/react-router";
import { useT } from "@/i18n/LanguageContext";
import { useSiteContent } from "@/lib/site-content";

export function SiteFooter() {
  const t = useT();
  const { ui, site, contactEmail, siteUrl, phones, social } = useSiteContent();
  return (
    <footer className="mt-32 border-t border-border/60 bg-[oklch(0.96_0.014_82)]/60">
      <div className="container-editorial py-16 grid gap-12 md:grid-cols-4">
        <div className="md:col-span-2">
          <h3 className="font-serif text-2xl">{t(ui.brand)}</h3>
          <p className="eyebrow mt-2 text-[0.6rem]">{t(ui.brandSub)}</p>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground max-w-sm">
            {t(site.shortDesc)}
          </p>
        </div>

        <div className="text-sm leading-relaxed">
          <p className="eyebrow text-2xl mb-4">{t(ui.footer.visit)}</p>
          <p>{t(site.address)}</p>
          <p className="text-muted-foreground mt-1">{t(site.city)}</p>
          <p className="mt-3">{t(site.hours)}</p>
          <p className="text-muted-foreground">{t(ui.footer.everyday)}</p>
        </div>

        <div className="text-sm leading-relaxed">
          <p className="eyebrow text-2xl mb-4">{t(ui.footer.contact)}</p>
          <a href={`mailto:${contactEmail}`} className="hover-underline break-all">
            {contactEmail}
          </a>
          <div className="mt-2 space-y-1">
            {phones.map((p) => (
              <a
                key={p.tel}
                href={`tel:${p.tel}`}
                className="block hover-underline text-muted-foreground"
              >
                {p.display}
              </a>
            ))}
          </div>
          <a
            href={siteUrl}
            target="_blank"
            rel="noreferrer"
            className="block mt-3 text-muted-foreground hover-underline"
          >
            {siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </a>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
            {social.instagram && (
              <a
                href={social.instagram}
                target="_blank"
                rel="noreferrer"
                className="hover-underline"
              >
                Instagram
              </a>
            )}
            {social.facebook && (
              <a
                href={social.facebook}
                target="_blank"
                rel="noreferrer"
                className="hover-underline"
              >
                Facebook
              </a>
            )}
            {social.line && (
              <a href={social.line} target="_blank" rel="noreferrer" className="hover-underline">
                LINE
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-border/60">
        <div className="container-editorial flex flex-col md:flex-row gap-3 md:items-center md:justify-between py-6 text-xs text-muted-foreground">
          <p>
            © {new Date().getFullYear()} {t(ui.footer.rights)}
          </p>
          <div className="flex gap-5">
            <Link to="/curation" className="hover-underline">
              {t(ui.nav.curation)}
            </Link>
            <Link to="/privacy" className="hover-underline">
              {t(ui.nav.privacy)}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
