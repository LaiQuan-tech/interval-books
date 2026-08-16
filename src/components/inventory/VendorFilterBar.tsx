/**
 * 廠商清單的篩選列。
 *
 * ⚠️ 每一個值都會被送到 server fn，篩選與排序全部在資料庫端做（見
 *    repos/inv-vendors.ts 的 SORTS 與那一段 .or(name.ilike…)）。前端不留一份完整
 *    清單再自己 filter —— 那樣「共 N 家」會變成「這一批有 N 家」。
 *
 * ⚠️ **搜尋框裡打統一編號或身分證字號是搜不到東西的，這是故意的。**
 *    repos/inv-vendors.ts 的搜尋範圍刻意不含任何識別碼欄位：允許用統編搜尋等於做出
 *    一個「輸入一個號碼、回答這個號碼在不在庫裡」的預言機，那是一條不留痕的外洩
 *    管道，即使它一個字元都沒有回傳。所以 placeholder 只寫得出名稱／代號／電話／
 *    email，不要「順手」把識別碼加進去。
 *
 * 廠商沒有分頁：正式庫 14 家，這是一家獨立書店的往來對象數量。repo 那邊的 limit 500
 * 是防呆不是分頁（與 inv-combos.ts 同一條）。
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
  VENDOR_ENTITY_TYPES,
  VENDOR_ENTITY_TYPE_LABELS,
  VENDOR_STATUSES,
  VENDOR_STATUS_LABELS,
  type VendorFilterValues,
} from "@/lib/admin/schemas";

type Props = {
  value: VendorFilterValues;
  onChange: (next: VendorFilterValues) => void;
  disabled?: boolean;
};

const CONSIGNMENT_OPTIONS: { code: VendorFilterValues["consignment"]; label: string }[] = [
  { code: "all", label: "全部" },
  { code: "yes", label: "寄售" },
  { code: "no", label: "買斷" },
];

const APPROVAL_OPTIONS: { code: VendorFilterValues["approvalStatus"]; label: string }[] = [
  { code: "all", label: "全部" },
  { code: "pending", label: "待審核" },
  { code: "approved", label: "已審核" },
  { code: "rejected", label: "已退回" },
];

const SORT_OPTIONS: { code: VendorFilterValues["sort"]; label: string }[] = [
  { code: "name_asc", label: "名稱（A→Z）" },
  { code: "name_desc", label: "名稱（Z→A）" },
  { code: "code_asc", label: "廠商代號" },
  { code: "created_desc", label: "最近建立" },
  { code: "products_desc", label: "商品數多→少" },
];

export function VendorFilterBar({ value, onChange, disabled }: Props) {
  function set(patch: Partial<VendorFilterValues>) {
    onChange({ ...value, ...patch });
  }

  const hasFilters =
    value.keyword !== null ||
    value.entityType !== "all" ||
    value.consignment !== "all" ||
    value.status !== "all" ||
    value.approvalStatus !== "all";

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4">
      <div className="min-w-56 flex-1 space-y-1.5">
        <Label htmlFor="vendor-search" className="text-xs">
          搜尋
        </Label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="vendor-search"
            className="pl-8"
            placeholder="名稱、簡稱、英文名、廠商代號、電話、email"
            value={value.keyword ?? ""}
            disabled={disabled}
            onChange={(e) => set({ keyword: e.target.value.trim() === "" ? null : e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">實體類型</Label>
        <Select
          value={value.entityType}
          disabled={disabled}
          onValueChange={(v) => set({ entityType: v as VendorFilterValues["entityType"] })}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            {VENDOR_ENTITY_TYPES.map((code) => (
              <SelectItem key={code} value={code}>
                {VENDOR_ENTITY_TYPE_LABELS[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">寄售</Label>
        <Select
          value={value.consignment}
          disabled={disabled}
          onValueChange={(v) => set({ consignment: v as VendorFilterValues["consignment"] })}
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONSIGNMENT_OPTIONS.map((o) => (
              <SelectItem key={o.code} value={o.code}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">往來狀態</Label>
        <Select
          value={value.status}
          disabled={disabled}
          onValueChange={(v) => set({ status: v as VendorFilterValues["status"] })}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            {VENDOR_STATUSES.map((code) => (
              <SelectItem key={code} value={code}>
                {VENDOR_STATUS_LABELS[code]}
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
          onValueChange={(v) => set({ approvalStatus: v as VendorFilterValues["approvalStatus"] })}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APPROVAL_OPTIONS.map((o) => (
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
          onValueChange={(v) => set({ sort: v as VendorFilterValues["sort"] })}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
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
            onChange({
              ...value,
              keyword: null,
              entityType: "all",
              consignment: "all",
              status: "all",
              approvalStatus: "all",
            })
          }
        >
          <X className="h-3.5 w-3.5" />
          清除篩選
        </Button>
      ) : null}
    </div>
  );
}
