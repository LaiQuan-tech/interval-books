/**
 * 進貨清單的篩選列（第一排：搜尋、分類、供應商、商品類型）。
 *
 * 第二排（狀態、日期、排序、每頁筆數、清除）在 PurchaseStatusFilters —— 這個檔案原本
 * 剛好 300 行，是自檢那條上限的零餘裕位置，再加一個條件就會越線。
 *
 * ⚠️ 每一個值都會被送到 server fn，篩選、排序與分頁全部在資料庫端做。來源是把整張
 *    purchases 撈回瀏覽器再 Array.filter + differenceInDays，所以它連分頁都沒有。
 *
 * ⚠️ page 歸零這件事在 set() 裡做一次就好 —— 兩排共用同一個 set，所以第二排改條件
 *    也一樣會回到第一頁。
 */
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  INV_PRODUCT_TYPES,
  INV_PRODUCT_TYPE_LABELS,
  type PurchaseFilterValues,
} from "@/lib/admin/schemas";
import { PurchaseStatusFilters } from "@/components/inventory/PurchaseStatusFilters";
import type { VendorOption } from "@/components/inventory/VendorSelect";

/** Radix Select 不接受空字串當 value，所以「全部」用這個哨兵值。 */
const ALL = "__all__";
type Props = {
  value: PurchaseFilterValues;
  onChange: (next: PurchaseFilterValues) => void;
  categories: { category_id: string; name: string }[];
  vendors: VendorOption[];
  disabled?: boolean;
  defaults: PurchaseFilterValues;
};

export function PurchaseFilterBar({
  value,
  onChange,
  categories,
  vendors,
  disabled,
  defaults,
}: Props) {
  // 任何條件變動都回到第一頁 —— 停在第 5 頁再換一個只有 3 頁結果的條件，畫面會是
  // 空的，而使用者看到的是「沒有資料」而不是「你在第 5 頁」。
  function set(patch: Partial<PurchaseFilterValues>) {
    onChange({ ...value, ...patch, page: 0 });
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="purchase-search" className="text-xs">
            搜尋
          </Label>
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="purchase-search"
              className="pl-8"
              placeholder="商品名稱、進貨品名、期數、系列、供應商、出版社"
              value={value.keyword ?? ""}
              disabled={disabled}
              onChange={(e) =>
                set({ keyword: e.target.value.trim() === "" ? null : e.target.value })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">分類</Label>
          <Select
            value={value.categoryId ?? ALL}
            disabled={disabled}
            onValueChange={(v) => set({ categoryId: v === ALL ? null : v })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部分類</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.category_id} value={c.category_id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">供應商</Label>
          <Select
            value={value.vendorId ?? ALL}
            disabled={disabled}
            onValueChange={(v) => set({ vendorId: v === ALL ? null : v })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部供應商</SelectItem>
              {vendors.map((v) => (
                <SelectItem key={v.vendor_id} value={v.vendor_id}>
                  {v.short_name || v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">商品類型</Label>
          <Select
            value={value.productType ?? ALL}
            disabled={disabled}
            onValueChange={(v) =>
              set({ productType: v === ALL ? null : (v as PurchaseFilterValues["productType"]) })
            }
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部類型</SelectItem>
              {INV_PRODUCT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {INV_PRODUCT_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <PurchaseStatusFilters
        value={value}
        defaults={defaults}
        disabled={disabled}
        onChange={onChange}
        onPatch={set}
      />
    </div>
  );
}
