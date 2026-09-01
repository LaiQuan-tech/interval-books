/**
 * 把 react-hook-form 的錯誤樹換成一句人看得懂的話。
 *
 * ── 為什麼這件事需要一個檔案 ────────────────────────────────────────────────
 * `form.handleSubmit(onValid)` 只傳一個參數的時候，**驗證失敗會什麼都不做**：沒有
 * 錯誤訊息、沒有 toast、沒有網路請求。在一個 Dialog 裡這還算堪用（表單很短，紅字
 * 就在眼前），但在一頁十一段、要捲三四個螢幕的組裝器上，那個紅字很可能在畫面外 ——
 * 使用者看到的是「我按了儲存，然後什麼都沒發生」。那是最糟的一種失敗：它連「失敗了」
 * 這個資訊都沒有給。
 *
 * 所以 handleSubmit 一定要傳第二個參數（onInvalid），而 onInvalid 一定要說出**是哪
 * 幾個欄位**。這個檔案就是「錯誤樹 → 那句話」。
 *
 * 🔴 invalidToastMessage() **永遠不回空字串**，就算一個欄位名都認不出來也一樣。
 *    回空字串等於 toast 出一個空白泡泡，那和什麼都不做沒有差別 —— 而「什麼都不做」
 *    正是這整個檔案存在的理由。
 *
 * ── 這個檔案為什麼一行 import 都沒有 ────────────────────────────────────────
 * 與 src/lib/admin/localized-list.ts、nav-active.ts、dirty-sections.ts 同一個理由：
 * 自檢要能直接 `await import()` 產線上真正跑的這一份，拿真的錯誤樹餵進去看它回什麼。
 */

/** react-hook-form 的錯誤節點：葉子有 message／type，中間節點是巢狀物件。 */
type ErrorNode = Record<string, unknown>;

const LEAF_KEYS = new Set(["message", "type", "ref", "types"]);

/**
 * 錯誤樹 → 點號路徑（例如 `title.en`、`product.price`、`highlights.zh`）。
 *
 * ⚠️ `ref` 底下是 DOM 節點，會有 parentNode 之類的環狀參照 —— 一定要跳過，否則
 *    這支函式會沿著 DOM 走到天亮。
 */
export function collectErrorPaths(errors: unknown, prefix = ""): string[] {
  if (!errors || typeof errors !== "object") return [];
  const node = errors as ErrorNode;

  // 葉子：有 message（zod 產生的每一條都有）就算數，不再往下走。
  if (typeof node.message === "string" && node.message.length > 0) {
    return prefix ? [prefix] : ["(表單)"];
  }

  const out: string[] = [];
  for (const key of Object.keys(node)) {
    if (LEAF_KEYS.has(key)) continue;
    const child = node[key];
    if (!child || typeof child !== "object") continue;
    out.push(...collectErrorPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

/**
 * 路徑 → 畫面上看得懂的名字。找不到對照就退回路徑本身（**不是**丟掉它 —— 丟掉會讓
 * 一個沒被登錄過的新欄位變成一次無聲的失敗）。
 */
export function labelForPath(path: string, labels: Readonly<Record<string, string>>): string {
  if (labels[path]) return labels[path];
  const base = path.split(".")[0];
  if (labels[base]) return labels[base];
  return path;
}

/**
 * onInvalid 要 toast 出去的那句話。
 *
 * 🔴 空清單也要回一句話。「按了儲存但什麼都沒發生」是這個檔案要消滅的東西，
 *    一個空字串的 toast 與它沒有差別。
 */
export function invalidToastMessage(
  paths: readonly string[],
  labels: Readonly<Record<string, string>> = {},
  max = 5,
): string {
  if (paths.length === 0) {
    return "有欄位沒有通過檢查，但無法指出是哪一個。請由上往下逐段檢查紅字。";
  }
  const names: string[] = [];
  for (const p of paths) {
    const name = labelForPath(p, labels);
    if (!names.includes(name)) names.push(name);
  }
  const shown = names.slice(0, max).join("、");
  const rest = names.length > max ? `，以及其他 ${names.length - max} 個欄位` : "";
  return `尚未儲存：${shown}${rest} 沒有通過檢查。畫面已捲到第一個有問題的欄位。`;
}
