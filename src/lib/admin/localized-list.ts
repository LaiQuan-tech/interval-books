/**
 * 「一行一項」清單欄位的純函式層 —— textarea 裡的一坨字 ⇄ string[]。
 *
 * 活動詳情頁有七個這種欄位（活動亮點、適合對象、不適合對象、帶得走什麼、流程大綱、
 * 費用包含、注意事項）。店家在後台一個 textarea 一行一項地打中文，按「自動翻譯」產生
 * 英日，最後存成 jsonb {"zh":[…],"en":[…],"ja":[…]}。這個檔案只管「字串 ⇄ 陣列」
 * 這一段換算，不知道有幾個欄位、不知道存到哪張表。
 *
 * ── 這個檔案為什麼一行 import 都沒有 ────────────────────────────────────────
 * 理由與 src/server/payuni.ts、src/server/blackcat.ts 相同：
 * scripts/localized-list-selftest.mjs 才能不經過 bundler、不經過 tsconfig 的 `@/`
 * alias，直接 `await import()` **產線上真正跑的這一份**。驗一份長得很像的複製品
 * 等於沒驗 —— 那只證明測試檔自己內部一致。
 *
 * ⚠️ 要加 import 之前先想清楚：一旦這裡出現 `@/…`，自檢就只剩「讀原始碼比對字串」
 *    這條路可走，而字串比對證明不了 linesToList 真的會丟錯。
 */

/**
 * 一份清單最多幾項。
 *
 * 這是「畫面上讀得完」的上限，不是資料庫上限（jsonb 沒有上限）。40 項的活動亮點
 * 已經不是亮點了。
 */
export const LIST_MAX_ITEMS = 40;

/**
 * 單一項目最多幾個字。
 *
 * 一行一項的東西超過 200 字就不是「一項」，是一段文案 —— 那種內容該進 description
 * 那類的自由欄位，不是進條列清單。
 */
export const LIST_MAX_ITEM_CHARS = 200;

/**
 * 一次送去翻譯的字數上限。
 *
 * ⚠️ 這個數字有三個地方寫著，而且必須一致：
 *      · 這裡（前端按下按鈕前先量，讓人當場看到「太長」）
 *      · src/lib/admin/schemas.ts 的 translateSchema `.max(2000, …)`（server fn 的門）
 *      · src/server/translate.ts 的 MAX_INPUT_CHARS（真的送出去之前再切一次）
 *    scripts/localized-list-selftest.mjs 會把三個地方讀出來對帳，改一個沒改另外兩個
 *    會直接紅。
 */
export const TRANSLATE_MAX_CHARS = 2000;

export type LocalizedListErrorKind = "too_many_items" | "item_too_long";

/**
 * 清單超出上限。
 *
 * 有 kind 是為了讓呼叫端能分辨「項數太多」與「某一行太長」—— 這兩件事要人做的
 * 補救動作不一樣（刪掉幾行 vs. 把某一行拆開）。
 */
export class LocalizedListError extends Error {
  readonly kind: LocalizedListErrorKind;
  constructor(kind: LocalizedListErrorKind, message: string) {
    super(message);
    this.name = "LocalizedListError";
    this.kind = kind;
  }
}

/**
 * textarea 的原始字串 → 去掉空白與空行之後的每一行。**不檢查任何上限，不會丟錯。**
 *
 * 存在的理由是畫面要能即時顯示「現在幾行」，包括**已經超過上限的時候**。如果數行數
 * 這件事會丟錯，超過上限的那一刻畫面就只能顯示「壞了」而顯示不出「你打了 45 行」，
 * 而後者才是人需要看到的那個數字。
 *
 * ⚠️ 第一步的換行正規化不能省。貼上來的內容常常是 CRLF（Windows 記事本、Word、
 *    Google 文件複製過來的都是），少了這一步 split("\n") 會讓每一行結尾都掛著一個
 *    \r，trim 之後看起來一模一樣、但單獨的 \r（老 Mac 換行）會讓整篇擠成一項 ——
 *    而且完全不會報錯，只是安靜地變成一行超長的東西。
 */
export function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * textarea 的原始字串 → 清單。超出上限就**丟錯**。
 *
 * 🔴 這裡刻意不 slice()。靜默截斷的意思是：店家填了 45 行、按了儲存、看到成功訊息，
 *    然後上線的頁面只有 40 行 —— 沒有任何人會發現，因為沒有任何地方會說。寧可在這裡
 *    擋下來讓人自己刪，也不要替他做一個他不知道的決定。
 *
 * 錯誤訊息一律講出「第幾行／共幾行」，因為 40 行的 textarea 裡「有一行太長」這種
 * 說法等於沒說。
 */
export function linesToList(text: string): string[] {
  const list = splitLines(text);

  if (list.length > LIST_MAX_ITEMS) {
    throw new LocalizedListError(
      "too_many_items",
      `清單最多 ${LIST_MAX_ITEMS} 項，目前共 ${list.length} 行（多了 ${list.length - LIST_MAX_ITEMS} 行）。` +
        `請自己刪到 ${LIST_MAX_ITEMS} 行以內 —— 系統不會替你砍掉多出來的那幾行。`,
    );
  }

  for (let i = 0; i < list.length; i += 1) {
    if (list[i].length > LIST_MAX_ITEM_CHARS) {
      throw new LocalizedListError(
        "item_too_long",
        `第 ${i + 1} 行（共 ${list.length} 行）有 ${list[i].length} 個字，` +
          `超過單項上限 ${LIST_MAX_ITEM_CHARS} 字。請把這一行拆短，或改放到說明欄位。`,
      );
    }
  }

  return list;
}

/**
 * 清單 → 回填 textarea 的字串。
 *
 * 與 linesToList 互為反向：對已經正規化過的輸入，
 * listToLines(linesToList(x)) === x。
 */
export function listToLines(list: string[]): string {
  return list.join("\n");
}
