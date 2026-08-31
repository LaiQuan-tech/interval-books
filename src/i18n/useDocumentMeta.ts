import { useEffect } from "react";
import { useLang } from "./LanguageContext";
import type { Localized } from "./types";

type MetaInput = {
  title: Localized;
  description: Localized;
  ogTitle?: Localized;
  ogDescription?: Localized;
  ogImage?: string;
};

function setMeta(selector: string, attr: "name" | "property", key: string, content: string) {
  if (typeof document === "undefined") return;
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/**
 * Reactively updates <title> and meta tags based on the current language.
 * Runs client-side only; SSR keeps the static fallback from each route's head().
 */
export function useDocumentMeta(meta: MetaInput) {
  const { lang } = useLang();

  useEffect(() => {
    const title = meta.title[lang] || meta.title.zh;
    const description = meta.description[lang] || meta.description.zh;
    const ogTitle = (meta.ogTitle ?? meta.title)[lang] || title;
    const ogDescription = (meta.ogDescription ?? meta.description)[lang] || description;

    document.title = title;
    setMeta('meta[name="description"]', "name", "description", description);
    setMeta('meta[property="og:title"]', "property", "og:title", ogTitle);
    setMeta('meta[property="og:description"]', "property", "og:description", ogDescription);
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", ogTitle);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", ogDescription);
    if (meta.ogImage) {
      setMeta('meta[property="og:image"]', "property", "og:image", meta.ogImage);
      setMeta('meta[name="twitter:image"]', "name", "twitter:image", meta.ogImage);
    } else {
      // Remove stale image tags from a previous route so each page only carries its own.
      document.head.querySelector('meta[property="og:image"]')?.remove();
      document.head.querySelector('meta[name="twitter:image"]')?.remove();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    lang,
    meta.title.zh,
    meta.title.en,
    meta.title.ja,
    meta.description.zh,
    meta.description.en,
    meta.description.ja,
    meta.ogTitle?.zh,
    meta.ogTitle?.en,
    meta.ogTitle?.ja,
    meta.ogDescription?.zh,
    meta.ogDescription?.en,
    meta.ogDescription?.ja,
    meta.ogImage,
  ]);
}
