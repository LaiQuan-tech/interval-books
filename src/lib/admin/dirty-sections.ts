/**
 * 活動頁組裝器的「哪幾段還沒存」狀態。
 *
 * ── 為什麼要有這一層，而不是直接看 form.formState.isDirty ────────────────────
 * 組裝器是一頁**很多段**的表單，而且未來每一段可能各自是一個獨立的編輯器（區塊那
 * 三段就是：faq／info_row／agenda 各有自己的 <form>，因為 HTML 的 form 不能巢狀）。
 * 「整頁髒不髒」是一個 boolean，答不出「是哪一段」——而使用者需要的正是後者：他捲
 * 到第 9 段，要知道第 2 段還有沒有沒存的東西。
 *
 * 所以每一個編輯器把自己的 isDirty 往上報，這裡把它們合起來。
 *
 * 🔴 **提示是條件式的，不是常駐句。** dirtyBannerText([]) 回 null —— 沒有髒東西的時候
 *    那一條 sticky bar 上**一個字都不該出現**。常駐一句「記得儲存」的下場是人在第三天
 *    就停止閱讀它，於是真的有東西沒存的那一次也一起被跳過。這件事寫成一支會回 null
 *    的純函式，是為了讓它可以被證明，而不是靠讀畫面。
 *
 * ── 這個檔案為什麼一行 import 都沒有 ────────────────────────────────────────
 * 與 src/lib/admin/localized-list.ts、src/lib/admin/nav-active.ts 同一個理由：
 * scripts/event-assembler-selftest.mjs 要直接 `await import()` **產線上真正跑的這一份**。
 */

/** 一段的識別字 → 它現在髒不髒。 */
export type DirtyState = Readonly<Record<string, boolean>>;

/**
 * 標記某一段的髒狀態。
 *
 * ⚠️ 值沒變就**回原本那個物件**（不是一個內容相同的新物件）。這一段會被 React 的
 *    setState 直接吃下去，回新物件等於每一次 onChange 都讓整頁重畫 —— 而整頁重畫在
 *    這一頁的代價是每一個區塊編輯器的非受控輸入都會被丟掉一次游標位置。
 */
export function markDirty(state: DirtyState, key: string, dirty: boolean): DirtyState {
  if ((state[key] ?? false) === dirty) return state;
  const next = { ...state };
  if (dirty) next[key] = true;
  else delete next[key];
  return next;
}

/** 現在有哪幾段是髒的（依加入順序）。 */
export function dirtyKeys(state: DirtyState): string[] {
  return Object.keys(state).filter((k) => state[k]);
}

/** 整頁有沒有沒存的東西。 */
export function hasDirty(state: DirtyState): boolean {
  return dirtyKeys(state).length > 0;
}

/**
 * sticky bar 上那一句話。**沒有髒東西就回 null** —— 呼叫端要據此整條不畫，
 * 而不是畫一條寫著「都存好了」的常駐提示。
 */
export function dirtyBannerText(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.length === 1) return `「${labels[0]}」有沒儲存的變更`;
  return `${labels.length} 段有沒儲存的變更：${labels.map((l) => `「${l}」`).join("、")}`;
}
