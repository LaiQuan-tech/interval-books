// UI 字串（導覽列、按鈕、區塊標題等）
import type { Localized } from "./types";

export const UI = {
  brand: { zh: "小時光書店", en: "Interval Books", ja: "小時光書店" },
  brandSub: { zh: "Interval Books", en: "Hourlight Bookstore", ja: "Interval Books" },

  nav: {
    home: { zh: "首頁", en: "Home", ja: "ホーム" },
    events: { zh: "活動", en: "Events", ja: "イベント" },
    exhibitions: { zh: "展覽", en: "Exhibitions", ja: "展覧" },
    journeys: { zh: "策旅", en: "Journeys", ja: "旅" },
    curated: { zh: "主理人的選品", en: "Curated", ja: "店主の選品" },
    visit: { zh: "來店資訊", en: "Visit", ja: "ご来店" },
    about: { zh: "關於", en: "About", ja: "について" },
    contact: { zh: "聯絡", en: "Contact", ja: "お問合せ" },
    curation: { zh: "策展與合作", en: "Curation & Collaboration", ja: "キュレーション" },
    privacy: { zh: "隱私權聲明", en: "Privacy", ja: "プライバシー" },
  },

  footer: {
    visit: { zh: "來訪", en: "Visit", ja: "ご来店" },
    contact: { zh: "聯繫", en: "Contact", ja: "お問合せ" },
    follow: { zh: "追蹤", en: "Follow", ja: "フォロー" },
    aboutBlurb: {
      zh: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。",
      en: "Tucked inside Huashan Cultural Park, Interval Books is a quiet pause — birdsong outside, the scent of tea and paper within, and the warmth of small encounters.",
      ja: "華山文化園にひっそりと佇む小時光書店。鳥のさえずり、茶と本の香り、ひとと人のあたたかな繋がりが息づく場所です。",
    },
    rights: {
      zh: "小時光書店．保留所有權利",
      en: "Interval Books. All rights reserved.",
      ja: "Interval Books. All rights reserved.",
    },
    everyday: { zh: "每日開放", en: "Open every day", ja: "年中無休" },
  },

  buttons: {
    toEvent: { zh: "前往活動網站", en: "Visit event site", ja: "イベントサイトへ" },
    toJourney: { zh: "前往旅程網站", en: "Visit journey site", ja: "旅のサイトへ" },
    toExhibition: { zh: "看展覽詳情", en: "View exhibition", ja: "展覧の詳細" },
    navigate: { zh: "點此導航", en: "Open in Maps", ja: "地図を開く" },
    emailUs: { zh: "Email 聯繫", en: "Email us", ja: "メールで問合せ" },
    line: { zh: "LINE 私訊", en: "Message on LINE", ja: "LINE で連絡" },
    inStore: { zh: "到店選購", en: "Visit in store", ja: "店頭でご覧" },
    viewAll: { zh: "查看全部", en: "View all", ja: "すべて見る" },
    backHome: { zh: "回到首頁", en: "Back home", ja: "ホームへ" },
  },

  sections: {
    thisMonth: { zh: "本月精選", en: "This Month", ja: "今月の特集" },
    featuredEvents: { zh: "精選活動", en: "Featured Events", ja: "特選イベント" },
    featuredExhibitions: { zh: "精選展覽", en: "Featured Exhibitions", ja: "特選展覧" },
    featuredJourney: { zh: "精選策旅", en: "Featured Journey", ja: "特選の旅" },
    latestNews: { zh: "最新消息", en: "Latest News", ja: "お知らせ" },
  },
} as const;

export const SITE_INFO = {
  shortDesc: {
    zh: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。",
    en: "Tucked inside Huashan Cultural Park, Interval Books is a quiet pause — birdsong outside, the scent of tea and paper within, and the warmth of small encounters.",
    ja: "華山文化園にひっそりと佇む小時光書店。鳥のさえずり、茶と本の香り、ひとと人のあたたかな繋がりが息づく場所です。",
  } as Localized,
  address: {
    zh: "華山文創園區．紅磚六合院 西7-3館",
    en: "Huashan 1914 Creative Park, Red Brick Courtyard, West 7-3",
    ja: "華山1914文化創意産業園區 紅煉瓦六合院 西7-3館",
  } as Localized,
  city: {
    zh: "台北市中正區",
    en: "Zhongzheng District, Taipei",
    ja: "台北市中正区",
  } as Localized,
  hours: {
    zh: "週一至週日 11:00 – 19:00",
    en: "Mon – Sun, 11:00 – 19:00",
    ja: "月〜日 11:00 – 19:00",
  } as Localized,
  closed: {
    zh: "每日開放（特殊節日另行公告）",
    en: "Open every day (special closures announced)",
    ja: "年中無休（特別休業は別途告知）",
  } as Localized,
};

export const CONTACT_EMAIL = "hello@intervalbooks.tw";
export const SITE_URL = "https://intervalbooks.tw";

export const SOCIAL = {
  instagram: "https://www.instagram.com/intervalbookstw/",
  facebook: "https://example.com", // 待替換
  line: "https://example.com", // 待替換
};

export const MAP = {
  embed: "https://www.google.com/maps?q=華山1914文化創意產業園區&output=embed",
  link: "https://goo.gl/maps/RB2ep3NoWFenLamV9",
};
