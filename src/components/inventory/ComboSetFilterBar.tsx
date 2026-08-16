/**
 * 套餐的篩選列。
 *
 * ⚠️ 每一個值都會被送到 server fn，篩選與排序全部在資料庫端做（見
 *    repos/inv-combos.ts 的 SORTS 與 .or(name.ilike…)）。前端不留一份完整清單
 *    再自己 filter —— 那樣「共 N 個」會變成「這一批有 N 個」。
 *
 * 套餐沒有分頁：正式庫 6 個，這輩子也不會變成 600 個（套餐是人手工排的菜單）。
 * repo 那邊的 limit 500 是防呆不是分頁。
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
  COMBO_ACTIVE_OPTIONS,
  COMBO_APPROVAL_OPTIONS,
  COMBO_SORT_OPTIONS,
} from "@/lib/admin/inv-combo-labels";
import type { ComboFilterValues } from "@/lib/admin/schemas";

type Props = {
  value: ComboFilterValues;
  onChange: (next: ComboFilterValues) => void;
  disabled?: boolean;
};

export function ComboSetFilterBar({ value, onChange, disabled }: Props) {
  function set(patch: Partial<ComboFilterValues>) {
    onChange({ ...value, ...patch });
  }

  const hasFilters =
    value.keyword !== null || value.activeStatus !== "all" || value.approvalStatus !== "all";

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4">
      <div className="min-w-56 flex-1 space-y-1.5">
        <Label htmlFor="combo-search" className="text-xs">
          搜尋
        </Label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="combo-search"
            className="pl-8"
            placeholder="套餐名稱、備註"
            value={value.keyword ?? ""}
            disabled={disabled}
            onChange={(e) => set({ keyword: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">上架狀態</Label>
        <Select
          value={value.activeStatus}
          disabled={disabled}
          onValueChange={(v) => set({ activeStatus: v as ComboFilterValues["activeStatus"] })}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMBO_ACTIVE_OPTIONS.map((o) => (
              <SelectItem key={o.code} value={o.code}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">審核狀態</Label>
        <Select
          value={value.approvalStatus}
          disabled={disabled}
          onValueChange={(v) => set({ approvalStatus: v as ComboFilterValues["approvalStatus"] })}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMBO_APPROVAL_OPTIONS.map((o) => (
              <SelectItem key={o.code} value={o.code}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">排序</Label>
        <Select
          value={value.sort}
          disabled={disabled}
          onValueChange={(v) => set({ sort: v as ComboFilterValues["sort"] })}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMBO_SORT_OPTIONS.map((o) => (
              <SelectItem key={o.code} value={o.code}>
                {o.label}
              </SelectItem>
            ))}
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
            onChange({ ...value, keyword: null, activeStatus: "all", approvalStatus: "all" })
          }
        >
          <X className="h-3.5 w-3.5" />
          清除篩選
        </Button>
      ) : null}
    </div>
  );
}
