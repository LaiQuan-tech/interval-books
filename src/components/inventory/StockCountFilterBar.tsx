/**
 * 盤點頁的篩選列。
 *
 * 從 _shell.inventory-count.tsx 抽出來，理由與 StockCountSummaryCards 相同：那個
 * 檔案原本把路由、統計卡、篩選列、清單與兩個對話框放在一起。
 *
 * ⚠️ 這一列的每一個值都會被送到 server fn，篩選與分頁都在資料庫端（見
 *    repos/inv-adjustments.ts 的 range()）。來源是把 993 筆整份撈回瀏覽器再
 *    Array.filter，而且每一次寫入都重抓一次。
 *
 * 「任何條件變動都回到第一頁」的重置留在呼叫端的 changeFilter —— 換頁走的是另一
 * 條路（那一條**不能**重置頁碼），兩者共用同一支 reload。
 */
import { Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INV_PRODUCT_TYPES, INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";

/** Radix Select 不接受空字串當 value，所以「全部」用這個哨兵值。 */
const ALL = "__all__";

export type CountFilter = {
  keyword: string | null;
  categoryId: string | null;
  productType: (typeof INV_PRODUCT_TYPES)[number] | null;
  lowStockOnly: boolean;
  page: number;
  pageSize: number;
};

type Props = {
  value: CountFilter;
  disabled: boolean;
  categories: { category_id: string; name: string; icon: string | null }[];
  onFilterChange: (patch: Partial<CountFilter>) => void;
};

export function StockCountFilterBar({ value, disabled, categories, onFilterChange }: Props) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4">
      <div className="min-w-56 flex-1 space-y-1.5">
        <Label htmlFor="count-search" className="text-xs">
          搜尋
        </Label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="count-search"
            className="pl-8"
            placeholder="商品名稱、期數、系列、條碼"
            value={value.keyword ?? ""}
            disabled={disabled}
            onChange={(e) =>
              onFilterChange({ keyword: e.target.value.trim() === "" ? null : e.target.value })
            }
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">分類</Label>
        <Select
          value={value.categoryId ?? ALL}
          disabled={disabled}
          onValueChange={(v) => onFilterChange({ categoryId: v === ALL ? null : v })}
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
        <Label className="text-xs">類型</Label>
        <Select
          value={value.productType ?? ALL}
          disabled={disabled}
          onValueChange={(v) =>
            onFilterChange({ productType: v === ALL ? null : (v as CountFilter["productType"]) })
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

      <label className="flex h-9 items-center gap-2 text-sm">
        <Checkbox
          checked={value.lowStockOnly}
          disabled={disabled}
          onCheckedChange={(v) => onFilterChange({ lowStockOnly: v === true })}
        />
        只看低庫存
      </label>
    </div>
  );
}
