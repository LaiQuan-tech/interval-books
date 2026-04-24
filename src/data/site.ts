// 站內資料（可手動編輯）。所有外部連結為 placeholder，待替換。

export type EventCategory = "讀書會" | "身心靈" | "講座" | "工作坊";

export interface EventItem {
  title: string;
  date: string;
  blurb: string;
  category: EventCategory;
  url: string; // 待替換：各活動獨立網站
}

export interface ExhibitionItem {
  slug: string;
  title: string;
  period: string;
  location: string;
  blurb: string;
  statement: string;
  image: string;
}

export interface JourneyItem {
  title: string;
  days: string;
  theme: string;
  blurb: string;
  url: string; // 待替換：各策旅獨立網站
}

export interface NewsItem {
  title: string;
  date: string;
  body: string;
}

export interface CuratedItem {
  name: string;
  note: string;
}

export interface CuratedTheme {
  title: string;
  description: string;
  items: CuratedItem[];
}

export const CONTACT_EMAIL = "hello@xiaoshiguang.tw"; // 待替換

export const SOCIAL = {
  instagram: "https://www.instagram.com/intervalbookstw/",
  facebook: "https://example.com", // 待替換
  line: "https://example.com", // 待替換
};

export const VISIT = {
  address: "華山文創園區 紅磚六合院 西7-3館",
  city: "台北市中正區",
  hours: "週一至週日 11:00 – 19:00",
  closed: "全年無休（特殊節日另行公告）",
  mapEmbed:
    "https://www.google.com/maps?q=華山1914文化創意產業園區&output=embed",
  mapLink: "https://maps.google.com/?q=華山1914文化創意產業園區",
};

export const events: EventItem[] = [
  {
    title: "風土誌讀書會｜土地與餐桌",
    date: "2025.05.10  週六  14:00",
    blurb: "從一本書、一道菜，回望腳下的土地。",
    category: "讀書會",
    url: "https://example.com/event-1",
  },
  {
    title: "靜走．呼吸與書頁之間",
    date: "2025.05.18  週日  10:00",
    blurb: "以閱讀為引，在身體裡安一個安靜的位置。",
    category: "身心靈",
    url: "https://example.com/event-2",
  },
  {
    title: "編輯講座｜如何閱讀一本地方誌",
    date: "2025.05.24  週六  19:30",
    blurb: "與獨立出版人對談，解構在地書寫的層次。",
    category: "講座",
    url: "https://example.com/event-3",
  },
  {
    title: "陶土工作坊｜手感器物的第一次",
    date: "2025.06.07  週六  13:30",
    blurb: "從一團土開始，捏出屬於自己的一只杯。",
    category: "工作坊",
    url: "https://example.com/event-4",
  },
  {
    title: "深夜讀書會｜詩與微光",
    date: "2025.06.14  週六  20:00",
    blurb: "在書店熄燈前的兩小時，留給詩。",
    category: "讀書會",
    url: "https://example.com/event-5",
  },
  {
    title: "聲音療癒｜頌缽之夜",
    date: "2025.06.21  週六  19:00",
    blurb: "以聲波鬆開肩頸，也鬆開一週的緊。",
    category: "身心靈",
    url: "https://example.com/event-6",
  },
];

export const exhibitions: ExhibitionItem[] = [
  {
    slug: "soil-and-page",
    title: "土壤與書頁",
    period: "2025.04.20 – 2025.06.15",
    location: "小時光書店．主展區",
    blurb: "六位地方書寫者與三位陶藝家，共構一場關於土地的閱讀。",
    statement:
      "本展以「風土」為線索，邀請文字與器物對話。書頁是被捻平的土地，陶土則是被烘烤的時間。我們希望觀者在閱讀與觸摸之間，重新感受腳下這片島嶼的紋理。",
    image: "/images/placeholder.svg",
  },
  {
    slug: "quiet-objects",
    title: "安靜的物件",
    period: "2025.07.05 – 2025.08.31",
    location: "小時光書店．東側書房",
    blurb: "選物與作品，在留白之中各自發聲。",
    statement:
      "策展團隊與三位設計師合作，挑選日用之器、文具與紙品。展期間每週末舉辦器物導讀，邀請觀者放慢腳步，從一支筆、一只杯，重新理解日常。",
    image: "/images/placeholder.svg",
  },
];

export const journeys: JourneyItem[] = [
  {
    title: "霧中山徑｜阿里山風土三日",
    days: "3 天 2 夜",
    theme: "茶、霧、山徑",
    blurb: "以一本山林之書為地圖，走進雲海與茶園的縫隙。",
    url: "https://example.com/journey-1",
  },
  {
    title: "島南慢讀｜恆春半島的風與書",
    days: "2 天 1 夜",
    theme: "海風、獨立書店、地方廚房",
    blurb: "拜訪南方的書店與廚房，讓海風翻動我們的書頁。",
    url: "https://example.com/journey-2",
  },
  {
    title: "陶土之路｜苗栗手作工藝旅",
    days: "2 天 1 夜",
    theme: "陶土、職人、地方料理",
    blurb: "踏訪窯場與工作室，親手帶回一只屬於自己的器。",
    url: "https://example.com/journey-3",
  },
];

export const news: NewsItem[] = [
  {
    title: "夏季展覽預告｜「安靜的物件」即將開幕",
    date: "2025.04.28",
    body: "我們將於七月推出新一檔策展，邀請三位設計師共同呈現日用之美。",
  },
  {
    title: "公休公告｜五月端午連假調整營業時間",
    date: "2025.04.20",
    body: "5/31 – 6/2 縮短營業至 17:00，敬請留意。",
  },
  {
    title: "策旅招募｜阿里山風土三日，5/15 開放報名",
    date: "2025.04.10",
    body: "由主理人帶隊，與在地茶人、書寫者一同踏訪山徑。",
  },
];

export const curatedThemes: CuratedTheme[] = [
  {
    title: "地方風土",
    description: "從一本地方誌，到一罐自家熬的果醬。",
    items: [
      { name: "山村釀造．桂花蜜", note: "南投手工小批次" },
      { name: "東海岸海鹽", note: "粗粒、慢曬" },
      { name: "苗栗黑糖磚", note: "古法柴燒" },
      { name: "阿里山高山茶", note: "春摘．烏龍" },
      { name: "金門高粱醋", note: "陳年三年" },
      { name: "花蓮米果", note: "在地稻米製" },
    ],
  },
  {
    title: "器物與陶",
    description: "每一只都是職人手中緩慢的時間。",
    items: [
      { name: "粗陶茶碗", note: "手捏．不規則口緣" },
      { name: "白瓷小皿", note: "釉下青花" },
      { name: "黑陶花器", note: "燻燒．霧面" },
      { name: "木製茶則", note: "台灣相思木" },
      { name: "亞麻織布巾", note: "天然染" },
      { name: "鑄鐵燭台", note: "霧黑塗裝" },
    ],
  },
  {
    title: "茶點小物",
    description: "讀一頁書，配一口靜。",
    items: [
      { name: "手工焙茶包", note: "三入裝" },
      { name: "海鹽可可", note: "70% 黑巧克力" },
      { name: "奶油酥餅", note: "古早味．小份量" },
      { name: "蜂蜜檸檬糖", note: "台南龍眼蜜" },
      { name: "杏仁脆片", note: "薄．脆．香" },
      { name: "桂圓紅棗茶", note: "冬季限定" },
    ],
  },
];

export const collaborations = [
  { title: "主題書展策展", desc: "為品牌、空間或機構量身打造的閱讀展。" },
  { title: "展覽與藝術合作", desc: "結合視覺、文字、器物的小型展覽。" },
  { title: "療癒生活節 / 市集", desc: "從選品到動線，打造有策展感的現場。" },
  { title: "品牌共創", desc: "為品牌設計閱讀活動、內容資產與企業接待。" },
  { title: "空間內容策展", desc: "為旅宿、咖啡館、辦公空間策劃選書與選物。" },
  { title: "深度策旅共創", desc: "與在地夥伴共同設計風土主題旅程。" },
];

export const cases = [
  { title: "風土誌．春之書展", line: "與獨立出版社共構的島嶼閱讀現場。" },
  { title: "靜山旅宿選書", line: "為山居旅宿挑選 200 冊主題書籍。" },
  { title: "品牌週年閱讀會", line: "為品牌策劃一場安靜而深刻的對談之夜。" },
];
