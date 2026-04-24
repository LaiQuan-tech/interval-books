import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <p className="eyebrow">404</p>
        <h2 className="display mt-4 text-4xl">頁面尚未開放</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          您正在尋找的頁面不存在，或已搬移至他處。
        </p>
        <div className="mt-8">
          <Link
            to="/"
            className="inline-flex items-center justify-center border border-foreground px-6 py-3 text-sm tracking-wide hover:bg-foreground hover:text-primary-foreground transition-colors"
          >
            回到首頁
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
      { title: "小時光書店｜風土誌策展的閱讀與生活場域" },
      { name: "description", content: "小時光風土誌書店，座落於華山文創園區的城市心臟，選擇與時間保持一點距離。在這裡，書不只是被閱讀，它是一種與土地對話的媒介。氣味、聲音、記憶與日常，透過書頁、空間與人，悄悄流動。" },
      { name: "author", content: "小時光書店" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "小時光書店" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:title", content: "小時光書店｜風土誌策展的閱讀與生活場域" },
      { name: "twitter:title", content: "小時光書店｜風土誌策展的閱讀與生活場域" },
      { property: "og:description", content: "小時光風土誌書店，座落於華山文創園區的城市心臟，選擇與時間保持一點距離。在這裡，書不只是被閱讀，它是一種與土地對話的媒介。氣味、聲音、記憶與日常，透過書頁、空間與人，悄悄流動。" },
      { name: "twitter:description", content: "小時光風土誌書店，座落於華山文創園區的城市心臟，選擇與時間保持一點距離。在這裡，書不只是被閱讀，它是一種與土地對話的媒介。氣味、聲音、記憶與日常，透過書頁、空間與人，悄悄流動。" },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/912c58c9-9a6c-461c-a342-86cf0de56fbd/id-preview-51422cad--c41cd2f7-a228-487f-b6dc-b1cca0632569.lovable.app-1777033513003.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/912c58c9-9a6c-461c-a342-86cf0de56fbd/id-preview-51422cad--c41cd2f7-a228-487f-b6dc-b1cca0632569.lovable.app-1777033513003.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Inter:wght@300;400;500&family=Noto+Sans+TC:wght@300;400;500&family=Noto+Serif+TC:wght@300;400;500&display=swap",
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
  return <Outlet />;
}
