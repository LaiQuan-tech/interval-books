import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Lang, Localized } from "./types";

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (l: Localized) => string;
};

const LanguageContext = createContext<Ctx | null>(null);
const STORAGE_KEY = "interval-books-lang";

function detectInitial(): Lang {
  if (typeof window === "undefined") return "zh";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved === "zh" || saved === "en" || saved === "ja") return saved;
  } catch {
    /* ignore */
  }
  const nav = (navigator.language || "").toLowerCase();
  if (nav.startsWith("ja")) return "ja";
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("en")) return "en";
  return "zh";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("zh");

  useEffect(() => {
    const initial = detectInitial();
    setLangState(initial);
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "zh" ? "zh-Hant" : lang === "ja" ? "ja" : "en";
    }
  }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  };

  const t = (entry: Localized) => entry[lang] || entry.zh;

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>{children}</LanguageContext.Provider>
  );
}

export function useLang() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLang must be used within LanguageProvider");
  return ctx;
}

export function useT() {
  return useLang().t;
}
