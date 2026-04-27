import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { LanguageProvider, useLang, useT } from "@/i18n/LanguageContext";
import { UI } from "@/i18n/strings";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <LanguageProvider>
      <NotFoundInner />
    </LanguageProvider>
  );
}

function NotFoundInner() {
  const t = useT();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <p className="eyebrow">404</p>
        <h2 className="display mt-4 text-4xl">
          {useLang().lang === "zh"
            ? "頁面尚未開放"
            : useLang().lang === "ja"
              ? "ページが見つかりません"
              : "Page not found"}
        </h2>
        <div className="mt-8">
          <Link
            to="/"
            className="inline-flex items-center justify-center border border-foreground px-6 py-3 text-sm tracking-wide hover:bg-foreground hover:text-primary-foreground transition-colors"
          >
            {t(UI.buttons.backHome)}
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "小時光書店 Interval Books｜風土誌策展的閱讀與生活場域" },
      { name: "description", content: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。" },
      { name: "author", content: "小時光書店 Interval Books" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "小時光書店 Interval Books" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Inter:wght@300;400;500&family=Noto+Sans+TC:wght@300;400;500&family=Noto+Sans+JP:wght@300;400;500&family=Noto+Serif+TC:wght@300;400;500&display=swap",
      },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <LanguageProvider>
      <Outlet />
    </LanguageProvider>
  );
}
