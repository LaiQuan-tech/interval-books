import type { Localized } from "@/i18n/types";

// === 共用型別（含二期預留欄位） ===
export type EventCategory =
  | "讀書會"
  | "療癒生活節"
  | "策旅說明會"
  | "陶藝家展售"
  | "身心靈工作坊"
  | "好書交流";

export interface EventItem {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  date: string; // 顯示用日期字串
  isoDate?: string; // 二期排序用
  category: EventCategory;
  externalUrl: string; // 一期：外連活動網站（待替換）
  registrationType: "external" | "internal"; // 二期擴充
  paymentEnabled: boolean; // 二期擴充
}

export interface ExhibitionItem {
  id: string;
  slug: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  period: string;
  location: Localized;
  image?: string;
}

export interface JourneyItem {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  days: Localized;
  theme: Localized;
  externalUrl: string; // 一期：外連
  registrationType: "external" | "internal";
  paymentEnabled: boolean;
}

export interface NewsItem {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  date: string;
}

export interface CuratedItem {
  name: Localized;
  note: Localized;
}

export interface CuratedTheme {
  id: string;
  title: Localized;
  description: Localized;
  items: CuratedItem[];
}

// === 資料 ===

export const events: EventItem[] = [
  {
    id: "ev-1",
    title: {
      zh: "風土誌讀書會｜土地與餐桌",
      en: "Terroir Reading Circle | Land & Table",
      ja: "風土誌読書会｜土地と食卓",
    },
    summary: {
      zh: "從一本書、一道菜，回望腳下的土地。",
      en: "A book, a dish, and the soil beneath our feet.",
      ja: "一冊の本と一皿の料理から、足元の大地を見つめ直す。",
    },
    description: {
      zh: "由風土書寫者帶讀，配一席在地餐桌，緩慢開啟對土地的感受。",
      en: "Guided by a terroir essayist, paired with a small local table.",
      ja: "風土エッセイストが導く読書と、ささやかな地のテーブル。",
    },
    date: "2025.05.10  Sat  14:00",
    category: "讀書會",
    externalUrl: "https://example.com/event-1", // 待替換
    registrationType: "external",
    paymentEnabled: false,
  },
  {
    id: "ev-2",
    title: {
      zh: "靜走．呼吸與書頁之間",
      en: "Quiet Walk: Between Breath and Page",
      ja: "静かな歩み｜呼吸と頁のあいだ",
    },
    summary: {
      zh: "以閱讀為引，在身體裡安一個安靜的位置。",
      en: "Reading as a doorway into the body's quiet room.",
      ja: "読書を糸口に、身体のなかに静けさの席をひとつ。",
    },
    description: {
      zh: "結合身體覺察與緩讀，適合初次接觸者。",
      en: "A gentle blend of body awareness and slow reading.",
      ja: "身体感覚とスローリーディングを組み合わせた、はじめての方にも優しい時間。",
    },
    date: "2025.05.18  Sun  10:00",
    category: "身心靈工作坊",
    externalUrl: "https://example.com/event-2", // 待替換
    registrationType: "external",
    paymentEnabled: false,
  },
  {
    id: "ev-3",
    title: {
      zh: "編輯講座｜如何閱讀一本地方誌",
      en: "Editor Talk: Reading a Place-Based Journal",
      ja: "編集者トーク｜地方誌の読み方",
    },
    summary: {
      zh: "與獨立出版人對談，解構在地書寫的層次。",
      en: "An evening with an independent publisher on layered place writing.",
      ja: "独立系編集者との対話で、ローカル・ライティングの層を読み解く。",
    },
    description: {
      zh: "現場帶來數本台灣地方誌，講者與讀者一同翻閱拆解。",
      en: "Several Taiwanese local journals on hand, opened together.",
      ja: "数冊の台湾地方誌を持ち寄り、参加者と一緒にページを開きます。",
    },
    date: "2025.05.24  Sat  19:30",
    category: "好書交流",
    externalUrl: "https://example.com/event-3", // 待替換
    registrationType: "external",
    paymentEnabled: false,
  },
  {
    id: "ev-4",
    title: {
      zh: "陶土工作坊｜手感器物的第一次",
      en: "Clay Workshop: Your First Vessel",
      ja: "陶土ワークショップ｜はじめての器",
    },
    summary: {
      zh: "從一團土開始，捏出屬於自己的一只杯。",
      en: "From a lump of earth, shape a cup of your own.",
      ja: "ひとかたまりの土から、自分だけの一碗を。",
    },
    description: {
      zh: "由駐店陶藝家帶領，以手捏方式完成第一件作品。",
      en: "Hand-built guidance from our resident ceramicist.",
      ja: "店内陶芸家が手びねりで第一作の制作をご案内します。",
    },
    date: "2025.06.07  Sat  13:30",
    category: "陶藝家展售",
    externalUrl: "https://example.com/event-4", // 待替換
    registrationType: "external",
    paymentEnabled: false,
  },
  {
    id: "ev-5",
    title: {
      zh: "深夜讀書會｜詩與微光",
      en: "Late-Night Reading: Poetry & Faint Light",
      ja: "深夜読書会｜詩と微光",
    },
    summary: {
      zh: "在書店熄燈前的兩小時，留給詩。",
      en: "Two hours before lights-out, given to poetry.",
      ja: "閉店前の二時間を、詩のために。",
    },
    description: {
      zh: "選讀華語詩人作品，輪流朗讀、低聲交談。",
      en: "Selected Sinophone poetry, read aloud and softly discussed.",
      ja: "中国語圏の詩を選び、朗読と静かな会話で過ごします。",
    },
    date: "2025.06.14  Sat  20:00",
    category: "讀書會",
    externalUrl: "https://example.com/event-5", // 待替換
    registrationType: "external",
    paymentEnabled: false,
  },
  {
    id: "ev-6",
    title: {
      zh: "聲音療癒｜頌缽之夜",
      en: "Sound Healing: A Singing Bowl Evening",
      ja: "サウンドヒーリング｜シンギングボウルの夜",
    },
    summary: {
      zh: "以聲波鬆開肩頸，也鬆開一週的緊。",
      en: "Let the bowls loosen the shoulders and the week.",
      ja: "響きで肩のこわばりも、一週間の緊張も、ほどいてゆく。",
    },
    description: {
      zh: "由認證頌缽老師帶領，建議帶上薄毯。",
      en: "Led by a certified practitioner. A light blanket is recommended.",
      ja: "認定講師による進行。薄手のブランケットをお持ちください。",
    },
    date: "2025.06.21  Sat  19:00",
    category: "療癒生活節",
    externalUrl: "https://example.com/event-6", // 待替換
    registrationType: "external",
    paymentEnabled: false,
  },
];

export const exhibitions: ExhibitionItem[] = [
  {
    id: "ex-1",
    slug: "soil-and-page",
    title: {
      zh: "土壤與書頁",
      en: "Soil and Page",
      ja: "土と頁",
    },
    summary: {
      zh: "六位地方書寫者與三位陶藝家，共構一場關於土地的閱讀。",
      en: "Six place-based writers and three ceramicists, on the reading of land.",
      ja: "六人の地方執筆者と三人の陶芸家による、土地をめぐる読書。",
    },
    description: {
      zh: "本展以「風土」為線索，邀請文字與器物對話。書頁是被捻平的土地，陶土則是被烘烤的時間。我們希望觀者在閱讀與觸摸之間，重新感受腳下這片島嶼的紋理。",
      en: "Following the thread of terroir, words and vessels enter into conversation. The page is flattened earth, clay is fired time. We hope visitors feel, between reading and touching, the texture of this island anew.",
      ja: "「風土」を糸口に、言葉と器が静かに対話します。頁は均された大地、陶土は焼かれた時間。読み、触れるあいだに、この島の肌理をもう一度感じていただければ。",
    },
    period: "2025.04.20 – 2025.06.15",
    location: {
      zh: "小時光書店．主展區",
      en: "Interval Books — Main Hall",
      ja: "小時光書店 メイン展示室",
    },
  },
  {
    id: "ex-2",
    slug: "quiet-objects",
    title: {
      zh: "安靜的物件",
      en: "Quiet Objects",
      ja: "静かな物たち",
    },
    summary: {
      zh: "選物與作品，在留白之中各自發聲。",
      en: "Curated objects and works, each speaking softly within white space.",
      ja: "選び抜かれた品々が、余白のなかで静かに語りはじめる。",
    },
    description: {
      zh: "策展團隊與三位設計師合作，挑選日用之器、文具與紙品。展期間每週末舉辦器物導讀，邀請觀者放慢腳步。",
      en: "In collaboration with three designers, selecting daily wares, stationery, and paper goods. Weekend object-readings throughout the run.",
      ja: "三人のデザイナーと協働し、日用の器、文具、紙ものを選びました。会期中は週末ごとに「物の読み聞かせ」を開催します。",
    },
    period: "2025.07.05 – 2025.08.31",
    location: {
      zh: "小時光書店．東側書房",
      en: "Interval Books — East Reading Room",
      ja: "小時光書店 東側ブックルーム",
    },
  },
];

export const journeys: JourneyItem[] = [
  {
    id: "jo-1",
    title: {
      zh: "如果可以慢下來｜\n風土策旅",
      en: "Misty Trails | Three Days in Alishan",
      ja: "霧の山道｜阿里山風土 三日",
    },
    summary: {
      zh: "以一本山林之書為地圖，走進雲海與茶園的縫隙。",
      en: "A book of mountains as our map, into the seams of cloud and tea.",
      ja: "一冊の山の本を地図に、雲海と茶畑のあわいへ。",
    },
    description: {
      zh: "與在地茶人、書寫者一同走訪山徑，住宿於老茶廠改建的旅宿。",
      en: "Walking the trails with local tea makers and writers; lodging in a converted old tea factory.",
      ja: "地元の茶人や書き手とともに山道を歩き、古い製茶工場を改装した宿に泊まります。",
    },
    days: { zh: "3 天 2 夜", en: "3 days · 2 nights", ja: "2泊3日" },
    theme: {
      zh: "山、海、人情",
      en: "Tea, mist, mountain paths",
      ja: "茶、霧、山道",
    },
    externalUrl: "https://example.com/journey-1", // 待替換
    registrationType: "external",
    paymentEnabled: false,
  },
  {
    id: "jo-2",
    title: {
      zh: "島南慢讀｜恆春半島的風與書",
      en: "Slow South | Wind & Books in Hengchun",
      ja: "島の南でゆっくり読む｜恒春半島の風と本",
    },
    summary: {
      zh: "拜訪南方的書店與廚房，讓海風翻動我們的書頁。",
      en: "Bookshops, kitchens, and a southern wind that turns our pages.",
      ja: "南の書店と厨房を訪ね、海風がページをめくる旅。",
    },
    description: {
      zh: "由主理人帶隊，串連恆春半島的獨立書店、地方廚房與海岸散步。",
      en: "Led by our owner: independent bookshops, local kitchens, and coastal walks.",
      ja: "店主が引率し、独立書店、ローカル・キッチン、海辺の散策をつなぎます。",
    },
    days: { zh: "2 天 1 夜", en: "2 days · 1 night", ja: "1泊2日" },
    theme: {
      zh: "海風、獨立書店、地方廚房",
      en: "Sea breeze, indie bookshops, local kitchens",
      ja: "海風、独立書店、ローカル厨房",
    },
    externalUrl: "https://example.com/journey-2", // 待替換
    registrationType: "external",
    paymentEnabled: false,
  },
  {
    id: "jo-3",
    title: {
      zh: "陶土之路｜苗栗手作工藝旅",
      en: "The Clay Road | Craft Days in Miaoli",
      ja: "陶土の道｜苗栗 手しごとの旅",
    },
    summary: {
      zh: "踏訪窯場與工作室，親手帶回一只屬於自己的器。",
      en: "Visit kilns and studios, and bring back a vessel of your own.",
      ja: "窯元と工房を訪ね、自分だけの器を持ち帰る。",
    },
    description: {
      zh: "拜訪三位苗栗陶藝家，於工作室現場手作一只茶碗或小皿。",
      en: "Three ceramicists in Miaoli; make a tea bowl or small dish in studio.",
      ja: "苗栗の陶芸家三名を訪ね、工房で茶碗か小皿を制作します。",
    },
    days: { zh: "2 天 1 夜", en: "2 days · 1 night", ja: "1泊2日" },
    theme: {
      zh: "陶土、職人、地方料理",
      en: "Clay, craftspeople, local cuisine",
      ja: "陶土、職人、地のごはん",
    },
    externalUrl: "https://example.com/journey-3", // 待替換
    registrationType: "external",
    paymentEnabled: false,
  },
];

export const news: NewsItem[] = [
  {
    id: "n-1",
    title: {
      zh: "夏季展覽預告｜「安靜的物件」即將開幕",
      en: "Summer preview: 'Quiet Objects' opens soon",
      ja: "夏の展覧予告｜「静かな物たち」開幕",
    },
    summary: {
      zh: "我們將於七月推出新一檔策展，邀請三位設計師共同呈現日用之美。",
      en: "A new July show with three designers presenting the beauty of daily wares.",
      ja: "七月、三名のデザイナーと日用の美を呈する新展を開きます。",
    },
    description: {
      zh: "展期 2025.07.05 – 2025.08.31，更多細節將陸續釋出。",
      en: "On view 2025.07.05 – 2025.08.31. More details to follow.",
      ja: "会期 2025.07.05 – 2025.08.31。詳細は順次公開します。",
    },
    date: "2025.04.28",
  },
  {
    id: "n-2",
    title: {
      zh: "公休公告｜五月端午連假調整營業時間",
      en: "Notice: Adjusted hours for the Dragon Boat holiday",
      ja: "営業時間のお知らせ｜端午節連休",
    },
    summary: {
      zh: "5/31 – 6/2 縮短營業至 17:00，敬請留意。",
      en: "May 31 – Jun 2: closing at 17:00.",
      ja: "5/31 – 6/2 は 17:00 閉店となります。",
    },
    description: {
      zh: "其餘時間維持原 11:00 – 19:00 營業。",
      en: "Otherwise open as usual, 11:00 – 19:00.",
      ja: "それ以外は通常通り 11:00 – 19:00 営業します。",
    },
    date: "2025.04.20",
  },
  {
    id: "n-3",
    title: {
      zh: "策旅招募｜阿里山風土三日，5/15 開放報名",
      en: "Journey open: Alishan three-day, signup May 15",
      ja: "旅の募集｜阿里山風土三日 5/15 受付開始",
    },
    summary: {
      zh: "由主理人帶隊，與在地茶人、書寫者一同踏訪山徑。",
      en: "Led by our owner with local tea makers and writers.",
      ja: "店主が引率、地元の茶人と書き手とともに山道を歩きます。",
    },
    description: {
      zh: "限額 12 人，詳情請見策旅頁面。",
      en: "Limited to 12 guests. See Journeys for details.",
      ja: "定員12名。詳細は「旅」のページへ。",
    },
    date: "2025.04.10",
  },
];

export const curatedThemes: CuratedTheme[] = [
  {
    id: "ct-1",
    title: { zh: "地方風土", en: "Place & Terroir", ja: "土地と風土" },
    description: {
      zh: "從一本地方誌，到一罐自家熬的果醬。",
      en: "From a local journal to a jar of home-cooked jam.",
      ja: "地方誌から、自家製のジャムまで。",
    },
    items: [
      {
        name: { zh: "山村釀造．桂花蜜", en: "Mountain Village Osmanthus Honey", ja: "山村醸造 桂花蜜" },
        note: { zh: "南投手工小批次", en: "Small batch from Nantou", ja: "南投の小ロット" },
      },
      {
        name: { zh: "東海岸海鹽", en: "East Coast Sea Salt", ja: "東海岸の海塩" },
        note: { zh: "粗粒、慢曬", en: "Coarse, slow-dried", ja: "粗粒、ゆっくり天日干し" },
      },
      {
        name: { zh: "苗栗黑糖磚", en: "Miaoli Brown Sugar Block", ja: "苗栗の黒糖ブロック" },
        note: { zh: "古法柴燒", en: "Wood-fired the old way", ja: "古法の薪焚き" },
      },
      {
        name: { zh: "阿里山高山茶", en: "Alishan High Mountain Tea", ja: "阿里山高山茶" },
        note: { zh: "春摘．烏龍", en: "Spring pick · Oolong", ja: "春摘み・烏龍" },
      },
      {
        name: { zh: "金門高粱醋", en: "Kinmen Sorghum Vinegar", ja: "金門高粱酢" },
        note: { zh: "陳年三年", en: "Aged three years", ja: "三年熟成" },
      },
      {
        name: { zh: "花蓮米果", en: "Hualien Rice Cracker", ja: "花蓮の米菓" },
        note: { zh: "在地稻米製", en: "Made with local rice", ja: "地の米から" },
      },
    ],
  },
  {
    id: "ct-2",
    title: { zh: "器物與陶", en: "Vessels & Clay", ja: "器と陶" },
    description: {
      zh: "每一只都是職人手中緩慢的時間。",
      en: "Each piece, the slow time of a maker's hands.",
      ja: "ひとつひとつが、職人の手のなかの緩やかな時間。",
    },
    items: [
      {
        name: { zh: "粗陶茶碗", en: "Stoneware Tea Bowl", ja: "粗陶の茶碗" },
        note: { zh: "手捏．不規則口緣", en: "Hand-pinched, irregular rim", ja: "手びねり・不揃いの縁" },
      },
      {
        name: { zh: "白瓷小皿", en: "White Porcelain Small Dish", ja: "白磁の小皿" },
        note: { zh: "釉下青花", en: "Underglaze blue-and-white", ja: "釉下の青花" },
      },
      {
        name: { zh: "黑陶花器", en: "Black Clay Vase", ja: "黒陶の花器" },
        note: { zh: "燻燒．霧面", en: "Smoke-fired, matte", ja: "燻し焼き・マット" },
      },
      {
        name: { zh: "木製茶則", en: "Wooden Tea Scoop", ja: "木の茶則" },
        note: { zh: "台灣相思木", en: "Taiwanese acacia", ja: "台湾相思木" },
      },
      {
        name: { zh: "亞麻織布巾", en: "Linen Cloth", ja: "リネンの布巾" },
        note: { zh: "天然染", en: "Naturally dyed", ja: "天然染め" },
      },
      {
        name: { zh: "鑄鐵燭台", en: "Cast Iron Candlestick", ja: "鋳鉄の燭台" },
        note: { zh: "霧黑塗裝", en: "Matte black finish", ja: "マットブラック仕上げ" },
      },
    ],
  },
  {
    id: "ct-3",
    title: { zh: "茶與日常", en: "Tea & Daily", ja: "茶と日々" },
    description: {
      zh: "讀一頁書，配一口靜。",
      en: "A page of reading, a sip of quiet.",
      ja: "一頁の読書に、ひと口の静けさを。",
    },
    items: [
      {
        name: { zh: "手工焙茶包", en: "Hand-roasted Tea Bags", ja: "手焙煎ティーバッグ" },
        note: { zh: "三入裝", en: "Set of three", ja: "三入り" },
      },
      {
        name: { zh: "海鹽可可", en: "Sea Salt Cocoa", ja: "海塩ココア" },
        note: { zh: "70% 黑巧克力", en: "70% dark chocolate", ja: "70% ダーク" },
      },
      {
        name: { zh: "奶油酥餅", en: "Butter Shortbread", ja: "バターショートブレッド" },
        note: { zh: "古早味．小份量", en: "Old-fashioned, small", ja: "昔ながら・小ぶり" },
      },
      {
        name: { zh: "蜂蜜檸檬糖", en: "Honey Lemon Drops", ja: "はちみつレモン飴" },
        note: { zh: "台南龍眼蜜", en: "Tainan longan honey", ja: "台南の龍眼蜜" },
      },
      {
        name: { zh: "杏仁脆片", en: "Almond Crisps", ja: "アーモンドクリスプ" },
        note: { zh: "薄．脆．香", en: "Thin, crisp, fragrant", ja: "薄く・香ばしく" },
      },
      {
        name: { zh: "桂圓紅棗茶", en: "Longan & Date Tea", ja: "竜眼と紅棗の茶" },
        note: { zh: "冬季限定", en: "Winter only", ja: "冬季限定" },
      },
    ],
  },
];

// === 策展與合作（低調）===
export const collaborations: { title: Localized; desc: Localized }[] = [
  {
    title: {
      zh: "療癒藝術節／療癒師品牌共創",
      en: "Healing Arts Festivals & Practitioner Brands",
      ja: "ヒーリング・アートフェス／セラピスト共創",
    },
    desc: {
      zh: "為節慶與品牌設計具策展感的療癒現場。",
      en: "Curated healing experiences for festivals and brands.",
      ja: "祭典やブランドのために、キュレーションされたヒーリングの場を。",
    },
  },
  {
    title: {
      zh: "空間策展",
      en: "Space Curation",
      ja: "空間キュレーション",
    },
    desc: {
      zh: "為旅宿、咖啡館、辦公空間策劃選書與選物。",
      en: "Books and objects for hotels, cafés, and offices.",
      ja: "宿、カフェ、オフィスのための選書と選品。",
    },
  },
  {
    title: {
      zh: "書店展售／茶品器具內容策展",
      en: "Bookshop Showcase & Tea-ware Content",
      ja: "書店ショーケース／茶道具の内容企画",
    },
    desc: {
      zh: "結合書、茶與器物的主題內容策劃。",
      en: "Themed editorial pairings of books, tea, and vessels.",
      ja: "本、茶、器物を組み合わせたテーマ企画。",
    },
  },
  {
    title: {
      zh: "品牌共創",
      en: "Brand Co-creation",
      ja: "ブランド共創",
    },
    desc: {
      zh: "為品牌設計閱讀活動、內容資產與企業接待。",
      en: "Reading events, content, and hospitality for brands.",
      ja: "ブランドのための読書プログラム、コンテンツ、ホスピタリティ。",
    },
  },
];
