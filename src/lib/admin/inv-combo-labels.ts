/**
 * 套餐頁的中文標籤 —— 分攤口徑、上架狀態、審核狀態、排序的**單一來源**。
 *
 * 與 inv-adjustment-labels.ts 同一個分工：代碼本身在 schemas.ts（那裡才是與資料庫
 * CHECK／view 對齊的地方），這個檔案只負責「這個代碼給人看的時候長什麼樣」。
 *
 * ⚠️ 分攤口徑的那兩句中文要與 components/pos/combo-basis.ts（櫃檯那一側）**逐字
 *    相同**。店員在櫃檯看到「按數量均分」、回到後台卻看到另一種說法的話，那張分攤
 *    表就沒有人會相信。這裡多的是 variant 與說明文字，後台才需要。
 */
import type { ComboFilterValues } from "@/lib/admin/schemas";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/**
 * 分攤口徑。這是整頁最重要的一個概念：一個套餐只有**一個組合價**，賣出去的時候要
 * 拆成每一件商品各自的營收，而拆法有兩種。口徑不是設定出來的，是 0018 §4 依「組成
 * 品項有沒有定價」自己算出來的 —— 缺一件就整組換口徑。
 */
export const ALLOCATION_BASIS_META: Record<
  "list_price" | "quantity",
  { label: string; short: string; description: string; variant: BadgeVariant }
> = {
  list_price: {
    label: "依定價比例分攤",
    short: "定價比例",
    description: "每一件組成品項都有售價，組合價按「售價 × 數量」的比例拆給它們。",
    variant: "outline",
  },
  quantity: {
    label: "按數量均分",
    short: "數量均分",
    description:
      "有組成品項沒有填售價，所以整組退回按數量均分。把售價補齊就會自動改回依定價比例分攤。",
    variant: "secondary",
  },
};

/** allocation_basis 是 null 代表這個套餐沒有組成品項 —— 它根本賣不出去。 */
export const NO_ITEMS_META = {
  label: "沒有組成品項",
  short: "無品項",
  description: "這個套餐沒有設定組成品項，資料庫會擋下販售（COMBO_NO_ITEMS）。",
  variant: "destructive" as BadgeVariant,
};

export function basisMeta(basis: "list_price" | "quantity" | null) {
  return basis === null ? NO_ITEMS_META : ALLOCATION_BASIS_META[basis];
}

export const COMBO_ACTIVE_OPTIONS: { code: ComboFilterValues["activeStatus"]; label: string }[] = [
  { code: "all", label: "全部" },
  { code: "active", label: "已上架" },
  { code: "inactive", label: "已下架" },
];

export const COMBO_APPROVAL_OPTIONS: {
  code: ComboFilterValues["approvalStatus"];
  label: string;
}[] = [
  { code: "all", label: "全部" },
  { code: "pending", label: "待審核" },
  { code: "approved", label: "已審核" },
  { code: "rejected", label: "已退回" },
];

export const COMBO_SORT_OPTIONS: { code: ComboFilterValues["sort"]; label: string }[] = [
  { code: "name_asc", label: "名稱 A→Z" },
  { code: "name_desc", label: "名稱 Z→A" },
  { code: "created_desc", label: "最新建立" },
  { code: "sold_desc", label: "已售組數由多到少" },
  { code: "price_desc", label: "組合價由高到低" },
];

/** 整站同一個寫法：NT$ 加千分位，null 印破折號而不是 0。 */
export function money(n: number | null | undefined): string {
  return n === null || n === undefined
    ? "—"
    : `NT$ ${Math.round(Number(n)).toLocaleString("zh-TW")}`;
}

/** 商品的顯示名稱：期數在名稱後面，與商品頁一致。 */
export function productLabel(name: string, issueNumber: string | null): string {
  return issueNumber ? `${name} #${issueNumber}` : name;
}
