export type Lang = "zh" | "en" | "ja";

export type Localized = {
  zh: string;
  en: string;
  ja: string;
};

/**
 * 三語的「一行一項」清單，對應 0027 在 public.events 上加的七個 jsonb 欄位
 * （highlights / suitable_for / … / notes）。
 *
 * 三個陣列是靠**索引**對齊的：zh[0] 與 en[0]、ja[0] 是同一項。長度不一致不是型別
 * 能擋的事，前台會少一項 —— 後台的 LocalizedListField 會在那個狀態跳警告並強制把
 * 英日區攤開。
 *
 * 三個都是空陣列 = 「這一塊關掉」，不是「還沒填」（0027 的 default 就是這個值）。
 */
export type LocalizedList = {
  zh: string[];
  en: string[];
  ja: string[];
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
