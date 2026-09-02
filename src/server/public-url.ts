/**
 * 「這個站對外的網址是什麼，而且它真的連得到嗎？」——**只有這一份答案。**
 *
 * ═══ 為什麼這個檔案存在 ═════════════════════════════════════════════════════
 *
 * 這條規則在這個 repo 裡出過一次錢的事故，而且已經被複製貼上三次。
 *
 * 🔴 2026-09-02，IB-202600001191，NT$1,800。`SITE_URL` **從來沒有設在 Vercel 上**，
 *    所以 siteUrl() 退回預設值 `http://localhost:8080`：客人刷卡成功被導到
 *    localhost（看到「無法連線」），而我們送給黑貓的 APN 網址也是 localhost，
 *    通知永遠不會到，訂單卡在 pending，兩小時後被 expire_unpaid_orders() 取消、
 *    座位還回去 —— 而錢已經收了。靠人工回查黑貓才救回來。整段紀錄在
 *    src/server/blackcat.ts 的 blackcatApnUrl() 上面。
 *
 * 修法當時寫在 blackcatApnUrl() 裡，然後 customer-auth.ts 的
 * customerAuthRedirectUrl() 又抄了一份（它的註解明著寫「刻意不從那兩支 import」）。
 * 0034 的匯款資訊信是**第三個**需要同一條判斷的地方 —— 而它是這個站第一封含連結
 * 的信，也是最難發現失敗的一個：一封寄到客人信箱、連結指向 localhost 的信，在我們
 * 這一側完全沒有任何錯誤（寄出成功、log 乾淨），只有客人那邊點下去打不開。
 *
 * 三份就該收成一份。
 *
 * ═══ 判準是「連得到嗎」，不是「哪個環境」 ═══════════════════════════════════
 *
 * 不看 NODE_ENV、不看 VERCEL_ENV。loopback 位址與非 https 的網址，**在任何環境下**
 * 都不是一個外部的人（金流商的伺服器、客人的信箱）連得到的目的地。用環境變數當
 * 判準的版本，正是那次事故通過的那道門。
 *
 * ═══ ⚠️ 這個檔案不可以 import 任何東西 ═════════════════════════════════════
 *
 * src/server/blackcat.ts 從這裡 import（相對路徑 + `.ts` 副檔名），而那支檔案的
 * 規約是「必須能被 scripts/blackcat-selftest.mjs 用 Node 的原生 type stripping
 * 直接載進來」——驗一份複本等於沒驗。任何 `@/…` 別名、任何會拖進
 * `@tanstack/react-start/server-only` 的東西，都會讓那支自檢載不動產線的檔案。
 *
 * 這條規約是**傳遞性**的：blackcat.ts 只 import node:crypto 與這一支，而這一支
 * 一個都不 import。scripts/blackcat-selftest.mjs [10] 對兩件事都有斷言。
 */

/**
 * 從外面永遠連不到的主機名。
 *
 * `.local` 是 mDNS，只在同一個區域網路內解析得到 —— 它不在這個 Set 裡，是在
 * isPubliclyReachableHost() 裡用後綴比對的。
 */
export const UNREACHABLE_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

/** 這個主機名，外面的人連得到嗎。 */
export function isPubliclyReachableHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (UNREACHABLE_HOSTS.has(h)) return false;
  if (h.endsWith(".local")) return false;
  return true;
}

/**
 * 站台對外的網址（結尾沒有斜線），**組不出可用的就回 null**。
 *
 * 回 null 的三種情況，呼叫端都必須當成「這件事做不成」而不是「用預設值繼續」：
 *   · SITE_URL 沒設（這就是那次事故）
 *   · 不是 https（客人的瀏覽器與金流商的伺服器都不吃）
 *   · 主機名從外面連不到（localhost / 127.0.0.1 / ::1 / 0.0.0.0 / *.local）
 *
 * ⚠️ 與 payuni.ts / blackcat.ts 的 `siteUrl()` **政策不同，不要混用**：那兩支一律
 *    回字串、永遠不回 null（它們的呼叫端有些真的需要一個本機網址，例如開發時的
 *    導回頁）。這一支是給「送到外面去的東西」用的。名字不一樣是刻意的 ——
 *    政策不同的東西共用一個名字才是真正會出事的地方。
 */
export function publicSiteUrl(): string | null {
  const base = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
  if (!base) return null;

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!isPubliclyReachableHost(url.hostname)) return null;
  return base;
}

/**
 * 對外網址加上一條路徑（與可選的 query），組不出來就回 null。
 *
 * `path` 要以 `/` 開頭。query 用物件傳而不是自己拼字串，encode 交給 URL。
 */
export function publicUrlFor(path: string, query?: Record<string, string>): string | null {
  const base = publicSiteUrl();
  if (base === null) return null;

  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  // 路徑或 query 有辦法把 host 換掉的話（例如 path 被傳成一個完整網址），上面那個
  // new URL 會以 base 為基準解析——但保險起見再確認一次，成本是零。
  if (url.protocol !== "https:" || !isPubliclyReachableHost(url.hostname)) return null;
  return url.toString();
}
