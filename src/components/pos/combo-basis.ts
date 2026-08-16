/**
 * 分攤口徑的中文 —— 櫃檯這一側的單一來源。
 *
 * 套餐只有**一個組合價**，賣出去的時候要拆成每一件組成品項各自的營收，而拆法有
 * 兩種。口徑不是誰設定的，是 0018 §4 依「組成品項有沒有定價」自己算出來的：缺一
 * 件就整組換口徑。所以這裡只翻譯，不判斷。
 *
 * ⚠️ 這是一個純函式模組，不是元件檔。放在這裡是為了讓 ComboCard／
 *    ComboCheckoutPanel／ComboResultPanel 三個檔案講同一句話 —— 結帳前看到的口徑
 *    與結帳後回報的口徑不一致的話，那張分攤表就沒有人會相信。
 */

export const ALLOCATION_BASIS_LABELS: Record<"list_price" | "quantity", string> = {
  list_price: "依定價比例分攤",
  quantity: "按數量均分",
};

/** null＝這組沒有組成品項，view 算不出口徑（資料庫端會擋下販售）。 */
export function basisLabel(basis: "list_price" | "quantity" | null): string {
  return basis ? ALLOCATION_BASIS_LABELS[basis] : "—";
}
