/**
 * 營收的計算規則 —— 儀表板的每一個數字最後都經過這裡。
 *
 * ═══ 為什麼規則要單獨成一個檔案 ═══════════════════════════════════════════
 *
 * 一個算錯的營收數字比沒有數字更糟：它看起來很正常，而且**不會有人發現**。訂單
 * 少算了一天、多算了一筆測試單，畫面上都只是一個略有不同的整數。所以「哪些列算數」
 * 與「一筆錢屬於哪一天」這兩件事被抽成純函式放在這裡，由
 * scripts/dashboard-revenue-selftest.mjs 直接 import 這一份**真的程式**驗證，
 * 而不是驗一份抄過去的副本。
 *
 * 這個檔案只 import ../event-status.ts（它自己是零 import），沒有 `@/` alias ——
 * 那是為了讓自檢能用 Node 原生型別剝離直接載入，不經 bundler。加相依之前先想清楚
 * 它在 `node scripts/…-selftest.mjs` 底下解不解得開。
 *
 * ═══ 🔴 這裡最重要的一條：兩個資料源會重複計算 ═══════════════════════════
 *
 * 錢有兩個來源，而且它們**有交集**：
 *
 *   · public.orders            線上訂單（total 是 TWD 整數）
 *   · public.inv_pos_sales     門市 POS（amount 是 numeric(10,2)）
 *
 * 線上訂單付款之後，commit_inventory_reservations()（0011 §7）**也會**往
 * inv.sales 插一筆 channel='online'、帶 web_order_id 的資料。所以
 *
 *     ❌ SUM(orders.total) + SUM(inv_pos_sales.amount)      線上商品被算兩次
 *     ✅ SUM(orders.total) + SUM(amount WHERE channel='pos') 才是對的
 *
 * 反過來「只用 inv.sales」也不行：它只收有 product_inventory_links 那一列的品項，
 * 而 0011:63 的表註解寫明「沒有列＝這個商品不受實體庫存管（event/journey 或純型錄
 * 品）」——**活動門票與策旅的營收從來沒有進過 inv.sales**，它也不含運費與訂單層級
 * 折扣。/admin/sales 自稱「唯一看得到今天總共賣了多少的地方」，那句話在只賣實體書
 * 的時代成立，現在不成立。
 */
import { todayInTaipei } from "../event-status.ts";

export { todayInTaipei };

/**
 * 台北日界。
 *
 * orders.paid_at 是 timestamptz，門市的 sale_date 是已經是台北日曆的 date。兩邊
 * 時間粒度不同，所以線上那一邊一定要先換算成台北日期才能跟門市放進同一個桶子。
 *
 * 沒有這一步的話，台北時間 00:00–08:00 成立的訂單會被算進前一天（UTC 還是昨天），
 * 「今日營收」在每天早上八點以前都會少算。
 */
const YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 一個 timestamptz（或任何 Date 解得開的字串）屬於台北的哪一天。 */
export function taipeiDayOf(iso: string): string {
  return YMD.format(new Date(iso));
}

/**
 * 不計入營收的付款方式。
 *
 * 只有 test_paid（沙盒測試單）。刻意**不**排除：
 *   · null   —— 「由店家聯繫付款」，錢還是收得到（0034 的欄位註解）
 *   · free   —— total 一定是 0，加總無害；但它會灌水「筆數」，所以另外數（見下）
 */
export const EXCLUDED_PAYMENT_METHODS = ["test_paid"] as const;

/** 門市那一側只取這個 channel —— 取 'online' 就會跟 orders 重複。見檔頭。 */
export const POS_REVENUE_CHANNEL = "pos";

export type RevenueOrderRow = {
  total: number;
  paid_at: string | null;
  payment_method: string | null;
  payment_status: string;
};

/**
 * 這一列算不算已實現營收。
 *
 * ⚠️ 判斷的是 **payment_status**，不是 status。status 走的是出貨流程，一筆已經
 *    收到錢的訂單會停在 'processing' 很久；拿它當營收條件會讓帳面永遠落後。
 *
 * ⚠️ **不看 archived_at。** 那只是後台列表的隱藏（0035）——已付款的訂單本來就刪
 *    不掉、只能封存。拿它當過濾條件等於把已經實現的營收靜靜地弄不見，而且封存幾筆
 *    就少幾筆，沒有任何地方會報錯。
 */
export function isRealisedRevenue(row: RevenueOrderRow): boolean {
  if (row.payment_status !== "paid") return false;
  if (!row.paid_at) return false;
  return !EXCLUDED_PAYMENT_METHODS.includes(row.payment_method as never);
}

/** 免費訂單（total=0）。金額不影響，但不該混進「幾筆訂單」。 */
export function isFreeOrder(row: RevenueOrderRow): boolean {
  return row.payment_method === "free";
}

// ── YYYY-MM-DD 的日期運算 ──────────────────────────────────────────────────
//
// 全部在字串／UTC 上做。這些字串**已經是台北日曆日期**了，再套一次時區只會把它
// 們平移；而台北沒有日光節約，所以「當成 UTC 算完再格式化回來」與在台北算是同一
// 個答案。刻意不用 date-fns：多一個相依就讓自檢載不動這個檔案。

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 某一天的 N 天前／後（N 可為負）。 */
export function addDays(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return formatYmd(d);
}

/** 這個月的第一天。 */
export function startOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** 這一年的第一天。 */
export function startOfYear(ymd: string): string {
  return `${ymd.slice(0, 4)}-01-01`;
}

/** 含頭含尾。兩邊都是 YYYY-MM-DD，字典序等於時間序。 */
export function withinRange(ymd: string, from: string, to: string): boolean {
  return ymd >= from && ymd <= to;
}

/** 從 from 到 to 的每一天，含頭含尾 —— 沒有營收的那幾天也要有桶子，否則折線圖會說謊。 */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ── 彙總 ───────────────────────────────────────────────────────────────────

export type RevenueSummary = {
  /** 線上訂單（orders.total）合計。 */
  online: number;
  /** 門市 POS（inv_pos_sales.amount，只取 channel='pos'）合計。 */
  pos: number;
  /** online + pos。畫面上兩邊分開標示再給這個總和 —— 對不起來的時候查得出是哪一邊。 */
  total: number;
  /** 計入營收的線上訂單筆數（不含免費訂單）。 */
  onlineOrders: number;
  /** 免費訂單筆數。單獨數，不混進上面那個。 */
  freeOrders: number;
  /** 門市銷售筆數。 */
  posSales: number;
};

export function emptySummary(): RevenueSummary {
  return { online: 0, pos: 0, total: 0, onlineOrders: 0, freeOrders: 0, posSales: 0 };
}

export type RevenuePosRow = {
  amount: number;
  sale_date: string;
  channel: string;
};

/**
 * 把兩個來源的原始列彙總成一個區間的數字。
 *
 * from / to 都是台北的 YYYY-MM-DD，含頭含尾。
 */
export function summariseRange(
  orders: RevenueOrderRow[],
  posSales: RevenuePosRow[],
  from: string,
  to: string,
): RevenueSummary {
  const out = emptySummary();

  for (const o of orders) {
    if (!isRealisedRevenue(o)) continue;
    if (!withinRange(taipeiDayOf(o.paid_at as string), from, to)) continue;
    out.online += o.total;
    if (isFreeOrder(o)) out.freeOrders += 1;
    else out.onlineOrders += 1;
  }

  for (const s of posSales) {
    // 這一條就是不重複計算的那道閘門。見檔頭。
    if (s.channel !== POS_REVENUE_CHANNEL) continue;
    if (!withinRange(s.sale_date, from, to)) continue;
    out.pos += s.amount;
    out.posSales += 1;
  }

  out.total = out.online + out.pos;
  return out;
}

export type RevenueDay = { day: string; online: number; pos: number; total: number };

/**
 * 每日分桶，給趨勢圖用。
 *
 * 區間內每一天都會有一列，沒有營收的那天是 0 而不是被跳過 —— 折線圖跳過空日等於
 * 把兩週的低潮畫成一條平緩的斜線。
 */
export function bucketByDay(
  orders: RevenueOrderRow[],
  posSales: RevenuePosRow[],
  from: string,
  to: string,
): RevenueDay[] {
  const byDay = new Map<string, RevenueDay>();
  for (const day of daysBetween(from, to)) {
    byDay.set(day, { day, online: 0, pos: 0, total: 0 });
  }

  for (const o of orders) {
    if (!isRealisedRevenue(o)) continue;
    const bucket = byDay.get(taipeiDayOf(o.paid_at as string));
    if (bucket) bucket.online += o.total;
  }

  for (const s of posSales) {
    if (s.channel !== POS_REVENUE_CHANNEL) continue;
    const bucket = byDay.get(s.sale_date);
    if (bucket) bucket.pos += s.amount;
  }

  for (const b of byDay.values()) b.total = b.online + b.pos;
  return [...byDay.values()];
}

/**
 * 儀表板要的三個區間。今天由呼叫端傳進來（預設是台北的今天），這樣自檢可以餵固定
 * 日期而不必假造系統時間。
 */
export function dashboardRanges(today: string = todayInTaipei()) {
  return {
    today: { from: today, to: today },
    month: { from: startOfMonth(today), to: today },
    year: { from: startOfYear(today), to: today },
    /** 趨勢圖：含今天在內的 30 天。 */
    trend: { from: addDays(today, -29), to: today },
  };
}
