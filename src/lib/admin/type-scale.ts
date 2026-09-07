/**
 * 後台的字級刻度 —— `/admin` 與 `/vendor` 兩個後台共用的唯一一份。
 *
 * ═══ 為什麼是覆寫 CSS 變數，不是改 class ═══════════════════════════════════
 *
 * 後台的字級散在 600 多處 class 裡（`text-xs` 297、`text-sm` 271，還有
 * src/components/{ui,inventory,pos,ocr}/ 底下那些前後台共用的元件）。逐一改有兩個
 * 問題：diff 大到沒有人能 review，而且**之後新加的頁面會自動退回舊字級** —— 沒有
 * 任何機制會提醒作者「這一頁的字比隔壁小」。
 *
 * Tailwind v4 把字級編成 CSS 變數：
 *
 *     .text-sm { font-size: var(--text-sm); line-height: var(--tw-leading, var(--text-sm--line-height)) }
 *
 * 所以覆寫 `--text-sm` 就等於一次改掉全部 168 處 `text-sm`，連 shadcn 元件內部的
 * 也一起。行高不必處理：`--text-sm--line-height` 是**無單位比例**
 * （`calc(1.25 / .875)`），會跟著 font-size 等比放大。
 *
 * 疊加順序也不必擔心：Tailwind 的 `@theme` 產出在 `@layer theme` 裡，而下面這段是
 * **未分層**的，未分層樣式一律贏過任何 layer，跟誰先誰後無關。
 *
 * ═══ 為什麼是 route 的 head()，不是包一個 class 在外框上 ═══════════════════
 *
 * 這是這件事唯一真正的陷阱。後台用了大約 40 個 Dialog、30 個 Select，還有
 * DropdownMenu、AlertDialog、手機版側欄（它是 Sheet）—— 這些全部是 React portal 到
 * `document.body`，**在後台外框的 DOM 之外**。把 class 掛在 SidebarProvider 上的話，
 * 結果會是頁面字大、彈窗字小。而且側欄收合時每一個導覽項目都有 portal 的 Tooltip，
 * 連「這一頁沒有彈窗」的頁面也躲不掉。
 *
 * route-level `styles` 產出的是 document 層級的 `<style>`（TanStack Router 的
 * HeadContent 會把它排在 appCss 之後），所以 portal 自然涵蓋；它在 SSR 就輸出，
 * 不會有一瞬間的小字；而且只在後台路由被 match 的時候存在，離開後台就消失，
 * 前台一個字都不會被動到。
 *
 * ⚠️ sonner 的 toast **不吃這一段**。它掛在 __root.tsx 的 <body> 底下（是 children
 *    的兄弟節點，在整個路由樹之外），而且它的字級是自己的 CSS 寫死的
 *    （node_modules/sonner/dist/styles.css 的 13px / 12px），不是 Tailwind class。
 *    要動它得在 src/styles.css 加規則，但那會**同時放大前台的 toast**——同一個
 *    Toaster。目前的決定是不動，後台 toast 維持原本大小。
 */

/**
 * 內文吃到最大的漲幅（14px→16px，+14%），標題只 +8%。
 *
 * 刻意**不等比放大**：後台需要的是更好讀的內文，不是更大的標題。整體乘一個係數會
 * 讓 24px 的標題變成 27px，把本來就長的列表頁版面撐得更鬆，卻沒有解決真正難讀的
 * 那一件事（14px 的表格內文）。所以是「往上壓縮一級」而不是「等比放大」。
 */
export const BACK_OFFICE_TYPE_SCALE_CSS = [
  ":root{",
  "--text-xs:0.8125rem;", // 12px → 13px
  "--text-sm:1rem;", // 14px → 16px（內文，168 處）
  "--text-base:1.125rem;", // 16px → 18px
  "--text-lg:1.25rem;", // 18px → 20px
  "--text-xl:1.375rem;", // 20px → 22px
  "--text-2xl:1.625rem;", // 24px → 26px
  "}",
].join("");

/**
 * 給 route 的 `head()` 用。六個後台入口都引用這一份：
 *
 *     head: () => ({ styles: backOfficeTypeScaleStyles() }),
 *     head: () => ({ meta: [{ title: "…" }], styles: backOfficeTypeScaleStyles() }),
 *
 * 六個而不是兩個，是因為 login／pending 三支刻意活在 _shell layout 之外
 * （登出或還沒被開通的人不該看到側欄），拿不到 layout 的 head。
 */
export function backOfficeTypeScaleStyles() {
  return [{ children: BACK_OFFICE_TYPE_SCALE_CSS }];
}
