/**
 * 活動是「已結束」還是「還沒到」。
 *
 * 規則只有一條：**活動日期的隔天起算已結束。** 活動當天仍然是進行中 —— 早上十點
 * 的工作坊，當天下午還看得到它在列表上，那是對的。
 *
 * ── 🔴 為什麼時區要寫死 ──────────────────────────────────────────────────
 * 這個站是 SSR 的。用 `new Date().getDate()` 那一組讀的是「執行環境」的時區：
 * 伺服器跑在 UTC，台北時間 9/5 早上八點時 UTC 還是 9/5 凌晨，看起來沒問題；但
 * 台北時間 9/6 早上七點時 UTC 才 9/5 23:00 —— 於是伺服器算出「還沒結束」而瀏覽器
 * 算出「已結束」，同一張卡片在 hydrate 前後跳一次。
 *
 * 同一個教訓在 src/components/shop/SessionPicker.tsx 的 formatSessionWhen() 已經
 * 踩過一次（10:00 的場次被 SSR 畫成 02:00）。這裡從一開始就寫死。
 */
const EVENT_TIME_ZONE = "Asia/Taipei";

const YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: EVENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 今天（台北）的 YYYY-MM-DD。 */
export function todayInTaipei(now: Date = new Date()): string {
  return YMD.format(now);
}

/**
 * 已結束？
 *
 * ⚠️ `isoDate` 為 null 時回 **false** —— 「沒有日期」不等於「已經結束」。正式庫
 *    裡確實有這種活動（display_date 是「即將公告」），把它們掃進已結束區等於讓
 *    還沒公布日期的活動從列表上消失。判不出來就留在進行中，這是刻意的。
 *
 * 字串直接比大小是安全的：兩邊都是 YYYY-MM-DD，字典序等於時間序。
 */
export function isPastEvent(isoDate: string | null | undefined, today = todayInTaipei()): boolean {
  if (!isoDate) return false;
  return isoDate < today;
}
