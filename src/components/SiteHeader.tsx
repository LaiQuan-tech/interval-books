import { Link } from "@tanstack/react-router";
import { useState } from "react";

const NAV = [
  { to: "/", label: "首頁" },
  { to: "/events", label: "活動" },
  { to: "/exhibitions", label: "展覽" },
  { to: "/curation", label: "策展與合作" },
  { to: "/journeys", label: "策旅" },
  { to: "/curated", label: "主理人的選品" },
  { to: "/visit", label: "來店資訊" },
  { to: "/about", label: "關於" },
  { to: "/contact", label: "聯絡" },
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="container-editorial flex items-center justify-between py-5">
        <Link to="/" className="flex flex-col leading-tight" onClick={() => setOpen(false)}>
          <span className="font-serif text-xl tracking-tight">小時光書店</span>
          <span className="eyebrow mt-1 text-[0.6rem]">Hourlight Bookstore</span>
        </Link>

        <nav className="hidden lg:flex items-center gap-7 text-[0.82rem] text-foreground/80">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === "/" }}
              activeProps={{ className: "text-foreground font-medium" }}
              className="hover-underline transition-colors hover:text-foreground"
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <button
          aria-label="開啟選單"
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
          <nav className="container-editorial flex flex-col py-6 gap-4 text-base">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                onClick={() => setOpen(false)}
                activeOptions={{ exact: n.to === "/" }}
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
