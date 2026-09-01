/**
 * 三種區塊在畫面上的**文案**，一種一組。
 *
 * ── 為什麼是「一個編輯器 + 三組設定」而不是三份複製 ──────────────────────────
 * faq／info_row／agenda 的資料形狀**完全相同**：0027 的 event_blocks 上就是
 * `title` + `body` 兩個三語欄位加一個 sort_order，三種 kind 共用同一張表、同一條
 * unique(event_id, kind, sort_order)、同一支 admin_reorder_event_blocks()。差別
 * 只有兩件事：**欄位叫什麼**（「時間」vs「標籤」vs「問題」）與 **body 要不要多行**。
 *
 * 三份複製的代價不是「多打三次字」，是往後每一次改行為都要改三個地方，而且沒有任何
 * 東西會提醒漏掉的那一個 —— 排序壞掉只會壞在三種裡的一種，而那一種可能三個月後才
 * 有人用到。
 *
 * ── 但也刻意**沒有**做成一個抽象 ────────────────────────────────────────────
 * 這裡不是 strategy／render-prop／欄位描述語言，就是**三個攤平的字串物件**。想知道
 * agenda 的第一個欄位叫什麼，往下讀 agenda 那一段就好，不必先讀懂一套設定格式。
 * 一旦哪一天有一種 kind 真的需要「不同的形狀」（不是不同的字），正確的動作是把它
 * 拆出去自己一支，而不是在這裡長出一個 `renderField` 參數。
 *
 * ⚠️ 這個檔案只有文案。**任何行為（驗證、排序、寫入）都不准住在這裡** —— 一個
 *    `Record<kind, …>` 一旦開始放函式，它就變成一個沒有名字的抽象層了。
 */
import type { EventBlockKind } from "@/lib/event-blocks";

export type EventBlockCopy = {
  /** §5／§8／§9 的段落標題。 */
  sectionTitle: string;
  /** 段落標題下面那一句。 */
  sectionDescription: string;
  /** event_blocks.title 這一欄在這一種 kind 底下叫什麼。 */
  titleLabel: string;
  /** event_blocks.body 這一欄在這一種 kind 底下叫什麼。 */
  bodyLabel: string;
  /** body 是不是多行（答案要多行，時間點與資訊列的值不用）。 */
  bodyMultiline: boolean;
  /** 「還沒有任何一列」時那一句話。 */
  emptyText: string;
  /** 新增表單的標題。 */
  addTitle: string;
  /** 這一種 kind 特有的提醒，寫在編輯器上方。沒有就是空字串。 */
  hint: string;
};

/**
 * ⚠️ key 一定是 EVENT_BLOCK_KINDS 那三個，一個不多一個不少。這是 `Record<EventBlockKind, …>`
 *    在型別層面保證的，自檢另外用執行期再對一次帳（型別會在 `as` 面前投降，執行期不會）。
 */
export const EVENT_BLOCK_COPY: Record<EventBlockKind, EventBlockCopy> = {
  agenda: {
    sectionTitle: "活動流程（agenda 區塊）",
    sectionDescription:
      "「19:30 入場、19:40 開場」這一種。一列一個時間點，由上到下就是前台的順序。",
    titleLabel: "時間",
    bodyLabel: "這個時間發生什麼",
    bodyMultiline: false,
    emptyText: "還沒有任何時間點。整段留空，前台就不會出現「活動流程」這一塊。",
    addTitle: "新增一個時間點",
    hint: "「時間」直接打你想印在前台的樣子（19:30、開演前 30 分鐘…），它是文字不是時間欄位——一場活動的流程常常有「開演前」這種講法。",
  },
  info_row: {
    sectionTitle: "資訊列（info_row 區塊）",
    sectionDescription: "標籤／值。交通、攜帶物品、退費規則這一類，一列一項。",
    titleLabel: "標籤",
    bodyLabel: "值",
    bodyMultiline: true,
    emptyText: "還沒有任何資訊列。整段留空，前台就不會出現這一塊。",
    addTitle: "新增一列資訊",
    hint: "🔴 這裡不要寫金額。售價的唯一真相是 §4 的商品售價——在這裡寫一個數字，前台就會印出一個結帳不會收的金額，而且沒有任何東西在維護它。",
  },
  faq: {
    sectionTitle: "常見問答（faq 區塊）",
    sectionDescription: "問／答。一列一組，前台畫成可以展開的手風琴。",
    titleLabel: "問題",
    bodyLabel: "答案",
    bodyMultiline: true,
    emptyText: "還沒有任何問答。整段留空，前台就不會出現「常見問答」這一塊。",
    addTitle: "新增一組問答",
    hint: "",
  },
};
