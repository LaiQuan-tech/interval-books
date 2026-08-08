import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useLang, useT } from "@/i18n/LanguageContext";
import { LANGS } from "@/i18n/types";
import { useSiteContent } from "@/lib/site-content";

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const t = useT();
  const { lang, setLang } = useLang();
  const { ui } = useSiteContent();

  const NAV = [
    { to: "/", label: t(ui.nav.home), exact: true },
    { to: "/events", label: t(ui.nav.events), exact: false },
    { to: "/exhibitions", label: t(ui.nav.exhibitions), exact: false },
    { to: "/journeys", label: t(ui.nav.journeys), exact: false },
    { to: "/curated", label: t(ui.nav.curated), exact: false },
    { to: "/visit", label: t(ui.nav.visit), exact: false },
    { to: "/about", label: t(ui.nav.about), exact: false },
    { to: "/contact", label: t(ui.nav.contact), exact: false },
  ] as const;

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="container-editorial flex items-center justify-between py-5 gap-6">
        <Link to="/" className="flex flex-col leading-tight" onClick={() => setOpen(false)}>
          <span className="font-serif text-xl tracking-tight">{t(ui.brand)}</span>
          <span className="eyebrow mt-1 text-[0.6rem]">{t(ui.brandSub)}</span>
        </Link>

        <nav className="hidden lg:flex items-center gap-6 text-[0.8rem] text-foreground/80">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.exact }}
              activeProps={{ className: "text-foreground font-medium" }}
              className="hover-underline transition-colors hover:text-foreground"
            >
              {n.label}
            </Link>
          ))}

          <span className="ml-2 flex items-center gap-2 border-l border-border/80 pl-4 text-[0.7rem] tracking-widest">
            {LANGS.map((l, i) => (
              <span key={l.code} className="flex items-center gap-2">
                {i > 0 && <span className="text-border">·</span>}
                <button
                  onClick={() => setLang(l.code)}
                  className={
                    lang === l.code
                      ? "text-foreground border-b border-foreground pb-0.5"
                      : "text-muted-foreground hover:text-foreground transition-colors"
                  }
                  aria-current={lang === l.code ? "true" : undefined}
                >
                  {l.label}
                </button>
              </span>
            ))}
          </span>
        </nav>

        <button
          aria-label="Menu"
          onClick={() => setOpen((v) => !v)}
          className="lg:hidden flex h-10 w-10 items-center justify-center text-foreground"
        >
          <span className="flex flex-col gap-1.5">
            <span className="block h-px w-6 bg-current" />
            <span className="block h-px w-6 bg-current" />
            <span className="block h-px w-6 bg-current" />
          </span>
        </button>
      </div>

      {open && (
        <div className="lg:hidden border-t border-border/60 bg-background">
          <div className="container-editorial pt-5 pb-2 flex items-center gap-3 text-[0.7rem] tracking-widest border-b border-border/40">
            {LANGS.map((l, i) => (
              <span key={l.code} className="flex items-center gap-3">
                {i > 0 && <span className="text-border">·</span>}
                <button
                  onClick={() => setLang(l.code)}
                  className={
                    lang === l.code
                      ? "text-foreground border-b border-foreground pb-0.5"
                      : "text-muted-foreground"
                  }
                >
                  {l.label}
                </button>
              </span>
            ))}
          </div>
          <nav className="container-editorial flex flex-col py-6 gap-4 text-base">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                onClick={() => setOpen(false)}
                activeOptions={{ exact: n.exact }}
                activeProps={{ className: "text-foreground font-medium" }}
                className="text-foreground/75"
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
