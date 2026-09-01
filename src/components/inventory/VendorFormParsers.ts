/**
 * 廠商模組的換形狀小工具（畫面上的字串 ⇄ 值）。
 *
 * 從 VendorFormDialog 抽出來。單獨一個檔案而不是跟 VendorFormState 放一起，是因為三張
 * 子表（聯絡人／匯款帳戶／附件）只需要 nz 與 intOrNull，不需要整份主檔表單狀態。
 *
 * ⚠️ 費率：資料庫存 0–1 的小數，畫面填百分比。乘除 100 之後有做 toFixed 收尾，因為
 *    0.1115 × 100 在 IEEE 754 下會變成 11.150000000000002。
 */
/** 空字串 → null。整份 payload 的規矩：沒填就是 null，不是 ""。 */
export function nz(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function intOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

/** 0–1 小數 → 畫面上的百分比字串。0.1115 → "11.15"（不是 11.150000000000002）。 */
export function rateToPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "";
  return String(Number((rate * 100).toFixed(4)));
}

/** 畫面上的百分比字串 → 0–1 小數。空字串是 null（資料庫會套自己的預設值）。 */
export function percentToRate(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return Number.NaN;
  return Number((n / 100).toFixed(6));
}

/** 金額 → 畫面字串。送審佇列與上架表單都要印同一種寫法，所以只留一份。 */
export function money(value: number | null): string {
  return value === null ? "—" : `NT$ ${Number(value).toLocaleString("zh-TW")}`;
}
