/**
 * 活動頁組裝器的字彙表 —— 段落種類與七個清單欄位的名字。
 *
 * 店家在後台由上到下編一頁活動：**後台段落的順序就是前台區塊的順序，某一段留空，
 * 前台那一整塊就消失**。這個檔案不知道怎麼渲染、也不知道怎麼存，它只負責「這一期
 * 承認哪幾種段落、哪七個清單欄位」這件事 —— 而且是**唯一**的那一份。
 *
 * ── 這個檔案為什麼一行 import 都沒有 ────────────────────────────────────────
 * 與 src/lib/admin/localized-list.ts、src/server/payuni.ts 同一個理由：
 * scripts/event-blocks-selftest.mjs 才能不經過 bundler、不經過 tsconfig 的 `@/`
 * alias，直接 `await import()` **產線上真正跑的這一份**，拿它去跟
 * supabase/migrations/0027_event_blocks.sql 的 CHECK 逐字對帳。驗一份長得很像的
 * 複製品等於沒驗。
 *
 * ⚠️ 要加 import 之前先想清楚：一旦這裡出現 `@/…`，自檢就只剩「讀原始碼比對字串」
 *    這條路可走 —— 而字串比對證明不了「SQL 認得的種類」與「TS 認得的種類」是同一組。
 */

/**
 * 一個活動可以掛哪幾種段落。**這串字要與 0027 的
 * `event_blocks_kind_valid` CHECK 逐字相等**（自檢會對帳）。
 *
 * 只有三種，而且三種都不是「版面」而是「內容形狀」：
 *
 *   · `faq`      —— 問／答。普世適用，而且 components/ui/accordion.tsx 已經在了。
 *   · `info_row` —— 標籤／值。**最有價值的一種**：這個 schema 沒有任何地址欄位，
 *                   費用說明、交通、攜帶物品、退費規則全部靠它吸收。
 *   · `agenda`   —— 時間／發生什麼。「19:30 入場／19:40 開場」是最常被問的一塊。
 *
 * 🔴 **刻意沒有 `pricing`。** public.event_sessions 刻意沒有 price 欄位（0020），
 *    金額的唯一真相在 products.price。一個 pricing 段落會在前台印出結帳不會收的
 *    金額 —— 那是第二個金錢真相，而且沒有任何東西在維護它。
 *
 * 🔴 **刻意沒有 `feature`。** 它的形狀與 info_row 完全相同，差別只有 CSS 欄數。
 *    加一個只差在版面的種類，就是「五種段落沒人分得出來該用哪個」的起點。
 */
export const EVENT_BLOCK_KINDS = ["faq", "info_row", "agenda"] as const;

export type EventBlockKind = (typeof EVENT_BLOCK_KINDS)[number];

/**
 * public.events 上的七個「一行一項」三語清單欄位，**順序就是前台由上到下的順序**。
 *
 * 每一欄都是 jsonb `{"zh":[…],"en":[…],"ja":[…]}`，not null，預設三個空陣列 ——
 * 空陣列的意思是「這一塊關掉」，不是「還沒填」。前台照這個順序畫，空的就整塊不畫。
 *
 * ⚠️ 是七個不是八個：快樂手那套「線上課程大綱／實體課程大綱」的二分對書店沒有意義
 *    （一場講座就是一場講座），合併成單一 `outline`。標籤那一欄也沒有 —— 既有的
 *    events.category 就是。
 */
export const EVENT_LIST_FIELDS = [
  "highlights",
  "suitable_for",
  "not_suitable_for",
  "takeaways",
  "outline",
  "includes",
  "notes",
] as const;

export type EventListField = (typeof EVENT_LIST_FIELDS)[number];

/**
 * 一個清單欄位的空值。
 *
 * 🔴 這與 0027 的 `default` 是同一個值，而且必須一直是同一個值：後台送出一個「全部
 *    清空」的欄位，與資料庫替一列新資料填的預設值，如果長得不一樣，前台就會需要
 *    兩套「這一塊是不是空的」判斷 —— 而那兩套一定會有一天不一致。
 */
export const EMPTY_LOCALIZED_LIST: Readonly<Record<"zh" | "en" | "ja", readonly string[]>> =
  Object.freeze({ zh: [], en: [], ja: [] });
