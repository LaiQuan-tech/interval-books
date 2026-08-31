/**
 * 在庫異動的篩選列。
 *
 * ⚠️ 每一個值都會被送到 server fn，篩選、排序、分頁全部在資料庫端做（見
 *    repos/inv-adjustments.ts 的 range()）。來源是「抓一批回來 → 前端 filter」，
 *    而且統計卡的分母就是那一批 —— 資料一多數字就開始說謊。
 *
 * ⚠️ 日期區間同時也是**統計卡的範圍**。這一列改了，上面六張卡要跟著重算。
 */
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  ADJUSTMENT_CATEGORY_OPTIONS,
  ADJUSTMENT_STATUS_OPTIONS,
} from "@/lib/admin/inv-adjustment-labels";
import type { AdjustmentFilterValues } from "@/lib/admin/schemas";

/** Radix Select 不接受空字串當 value，所以「全部」用這個哨兵值。 */
const ALL = "__all__";

type Props = {
  value: AdjustmentFilterValues;
  onChange: (next: AdjustmentFilterValues) => void;
  disabled?: boolean;
};

export function AdjustmentFilterBar({ value, onChange, disabled }: Props) {
  // 任何條件變動都回到第一頁。
  function set(patch: Partial<AdjustmentFilterValues>) {
    onChange({ ...value, ...patch, page: 0 });
  }

  const hasFilters =
    value.keyword !== null ||
    value.category !== null ||
    value.status !== "all" ||
    value.dateFrom !== null ||
    value.dateTo !== null;

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="adj-search" className="text-xs">
            搜尋
          </Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="adj-search"
              className="pl-8"
              placeholder="單號、商品名稱、期數、備註"
              value={value.keyword ?? ""}
              disabled={disabled}
              onChange={(e) =>
                set({ keyword: e.target.value.trim() === "" ? null : e.target.value })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">類別</Label>
          <Select
            value={value.category ?? ALL}
            disabled={disabled}
            onValueChange={(v) =>
              set({ category: v === ALL ? null : (v as AdjustmentFilterValues["category"]) })
            }
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部類別</SelectItem>
              {ADJUSTMENT_CATEGORY_OPTIONS.map((o) => (
                <SelectItem key={o.code} value={o.code}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">狀態</Label>
          <Select
            value={value.status}
            disabled={disabled}
            onValueChange={(v) => set({ status: v as AdjustmentFilterValues["status"] })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部狀態</SelectItem>
              {ADJUSTMENT_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.code} value={o.code}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="adj-from" className="text-xs">
            起日
          </Label>
          <Input
            id="adj-from"
            type="date"
            className="w-40"
            value={value.dateFrom ?? ""}
            disabled={disabled}
            onChange={(e) => set({ dateFrom: e.target.value === "" ? null : e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="adj-to" className="text-xs">
            迄日
          </Label>
          <Input
            id="adj-to"
            type="date"
            className="w-40"
            value={value.dateTo ?? ""}
            disabled={disabled}
            onChange={(e) => set({ dateTo: e.target.value === "" ? null : e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">排序</Label>
          <Select
            value={value.sort}
            disabled={disabled}
            onValueChange={(v) => set({ sort: v as AdjustmentFilterValues["sort"] })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date_desc">日期由新到舊</SelectItem>
              <SelectItem value="date_asc">日期由舊到新</SelectItem>
              <SelectItem value="created_at">最新建立</SelectItem>
              <SelectItem value="quantity_desc">數量由大到小</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...value,
                keyword: null,
                category: null,
                status: "all",
                dateFrom: null,
                dateTo: null,
                page: 0,
              })
            }
          >
            <X className="h-3.5 w-3.5" />
            清除篩選
          </Button>
        ) : null}
      </div>
    </div>
  );
}
