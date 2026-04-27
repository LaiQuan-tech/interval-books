export type Lang = "zh" | "en" | "ja";

export type Localized = {
  zh: string;
  en: string;
  ja: string;
};

export const LANGS: { code: Lang; label: string }[] = [
  { code: "zh", label: "ZH" },
  { code: "en", label: "EN" },
  { code: "ja", label: "JA" },
];

export const HTML_LANG: Record<Lang, string> = {
  zh: "zh-Hant",
  en: "en",
  ja: "ja",
};
