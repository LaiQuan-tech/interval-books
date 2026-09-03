import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ShoppingBag, UserRound } from "lucide-react";
import { useLang, useT } from "@/i18n/LanguageContext";
import { LANGS } from "@/i18n/types";
import { useCartCount, useCartHydrated } from "@/lib/cart";
import { useSiteContent } from "@/lib/site-content";

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const t = useT();
  const { lang, setLang } = useLang();
  const { ui } = useSiteContent();

  /**
   * 五格。2026-09-02 從九格收束而來，兩組合併：
   *
   *   /shop        ← 選購 ＋ 地方刊物展 ＋ 主理人的選品（同一頁三個分頁）
   *   /about       ← 關於 ＋ 來店資訊 ＋ 聯絡
   *
   * 被收掉的四個網址（/publications /curated /visit /contact）都還在，各自轉址到
   * 新家 —— 它們散在 Google 商家、名片與社群貼文上，刪掉就是 404。
   *
   * 標籤走 nav.select / nav.aboutStore 這兩個新 key，理由見 src/i18n/strings.ts。
   */
  const NAV = [
    { to: "/", label: t(ui.nav.home), exact: true },
    { to: "/shop", label: t(ui.nav.select), exact: false },
    { to: "/events", label: t(ui.nav.events), exact: false },
    { to: "/journeys", label: t(ui.nav.journeys), exact: false },
    { to: "/about", label: t(ui.nav.aboutStore), exact: false },
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

          <AccountLink label={t(ui.nav.account)} />
          <CartLink label={t(ui.nav.cart)} />
        </nav>

        <div className="flex items-center gap-1 lg:hidden">
          <AccountLink label={t(ui.nav.account)} onNavigate={() => setOpen(false)} />
          <CartLink label={t(ui.nav.cart)} onNavigate={() => setOpen(false)} />
          <button
            aria-label="Menu"
            onClick={() => setOpen((v) => !v)}
            className="flex h-10 w-10 items-center justify-center text-foreground"
          >
            <span className="flex flex-col gap-1.5">
              <span className="block h-px w-6 bg-current" />
              <span className="block h-px w-6 bg-current" />
              <span className="block h-px w-6 bg-current" />
            </span>
          </button>
        </div>
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
            <Link
              to="/cart"
              onClick={() => setOpen(false)}
              activeProps={{ className: "text-foreground font-medium" }}
              className="text-foreground/75"
            >
              {t(ui.nav.cart)}
            </Link>
            <Link
              to="/account"
              onClick={() => setOpen(false)}
              activeProps={{ className: "text-foreground font-medium" }}
              className="text-foreground/75"
            >
              {t(ui.nav.account)}
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}

/**
 * Cart icon with a unit-count badge.
 *
 * The count is gated on useCartHydrated(): the cart lives in localStorage, so
 * the server has no idea what is in it. Rendering the real number on the first
 * client pass would disagree with the SSR HTML and trip a hydration mismatch —
 * hence "0 until the effect has read storage", which is the same discipline
 * every cart-reading component in Realreal follows.
 */
function CartLink({ label, onNavigate }: { label: string; onNavigate?: () => void }) {
  const hydrated = useCartHydrated();
  const storedCount = useCartCount();
  const count = hydrated ? storedCount : 0;

  return (
    <Link
      to="/cart"
      onClick={onNavigate}
      aria-label={count > 0 ? `${label} (${count})` : label}
      className="relative ml-2 flex h-10 w-10 items-center justify-center text-foreground/80 transition-colors hover:text-foreground"
    >
      <ShoppingBag className="h-5 w-5" aria-hidden="true" />
      {count > 0 && (
        <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-foreground px-1 text-center text-[0.6rem] leading-4 text-primary-foreground tabular-nums">
          {count}
        </span>
      )}
    </Link>
  );
}

/**
 * 客人帳號的入口（2026-09-03）。刻意用圖示、不佔用文字導覽的五格——見上面 NAV
 * 那段「九格 → 五格」的理由，同一個空間預算。
 *
 * 一律指到 /account，不在頁首自己判斷有沒有登入：那一頁自己的 beforeLoad 會導去
 * /account/login（見 routes/account.tsx 檔頭）。這裡不重複判斷一次，避免登入
 * 狀態的判斷分散在兩個地方。
 */
function AccountLink({ label, onNavigate }: { label: string; onNavigate?: () => void }) {
  return (
    <Link
      to="/account"
      onClick={onNavigate}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 items-center justify-center text-foreground/80 transition-colors hover:text-foreground"
    >
      <UserRound className="h-5 w-5" aria-hidden="true" />
    </Link>
  );
}
