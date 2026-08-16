/**
 * 進貨清單的篩選列。
 *
 * ⚠️ 每一個值都會被送到 server fn，篩選、排序與分頁全部在資料庫端做。來源是把整張
 *    purchases 撈回瀏覽器再 Array.filter + differenceInDays，所以它連分頁都沒有。
 *
 * ⚠️ 「效期狀態」在資料庫端只能用固定的 30 天上界撈（PostgREST 沒辦法拿一個欄位去
 *    比另一個欄位），真正 per-row 的 expiry_alert_days 判斷在表格那一層。文案因此
 *    寫「即將到期」而不是「N 天內到期」—— 每一列的門檻本來就不一樣。
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
  INV_PRODUCT_TYPES,
  INV_PRODUCT_TYPE_LABELS,
  type PurchaseFilterValues,
} from "@/lib/admin/schemas";
import type { VendorOption } from "@/components/inventory/VendorSelect";

/** Radix Select 不接受空字串當 value，所以「全部」用這個哨兵值。 */
const ALL = "__all__";
const PAGE_SIZES = [25, 50, 100, 200];
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

  const hasFilters =
    value.keyword !== null ||
    value.categoryId !== null ||
    value.vendorId !== null ||
    value.productType !== null ||
    value.approvalStatus !== "all" ||
    value.expiryStatus !== "all" ||
    value.stockStatus !== "all" ||
    value.dateFrom !== null ||
    value.dateTo !== null;

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

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">審核狀態</Label>
          <Select
            value={value.approvalStatus}
            disabled={disabled}
            onValueChange={(v) =>
              set({ approvalStatus: v as PurchaseFilterValues["approvalStatus"] })
            }
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部狀態</SelectItem>
              <SelectItem value="pending">待審核</SelectItem>
              <SelectItem value="approved">已審核</SelectItem>
              <SelectItem value="rejected">已退回</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">效期狀態</Label>
          <Select
            value={value.expiryStatus}
            disabled={disabled}
            onValueChange={(v) => set({ expiryStatus: v as PurchaseFilterValues["expiryStatus"] })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部效期</SelectItem>
              <SelectItem value="expiring">需關注（含已過期）</SelectItem>
              <SelectItem value="expired">已過期</SelectItem>
              <SelectItem value="warning">即將到期</SelectItem>
              <SelectItem value="no_expiry">未設效期</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">庫存狀態</Label>
          <Select
            value={value.stockStatus}
            disabled={disabled}
            onValueChange={(v) => set({ stockStatus: v as PurchaseFilterValues["stockStatus"] })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="in_stock">還有剩餘</SelectItem>
              <SelectItem value="used_up">已用完</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="purchase-from" className="text-xs">
            進貨日期起
          </Label>
          <Input
            id="purchase-from"
            type="date"
            className="w-40"
            value={value.dateFrom ?? ""}
            disabled={disabled}
            onChange={(e) => set({ dateFrom: e.target.value || null })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="purchase-to" className="text-xs">
            進貨日期迄
          </Label>
          <Input
            id="purchase-to"
            type="date"
            className="w-40"
            value={value.dateTo ?? ""}
            disabled={disabled}
            onChange={(e) => set({ dateTo: e.target.value || null })}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">排序</Label>
          <Select
            value={value.sort}
            disabled={disabled}
            onValueChange={(v) => set({ sort: v as PurchaseFilterValues["sort"] })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="purchase_date_desc">進貨日期新→舊</SelectItem>
              <SelectItem value="purchase_date_asc">進貨日期舊→新</SelectItem>
              <SelectItem value="created_at">最新建立</SelectItem>
              <SelectItem value="quantity_desc">數量由多到少</SelectItem>
              <SelectItem value="remaining_asc">剩餘由少到多</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">每頁筆數</Label>
          <Select
            value={String(value.pageSize)}
            disabled={disabled}
            onValueChange={(v) => set({ pageSize: Number(v) })}
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
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
            onClick={() => onChange({ ...defaults, sort: value.sort, pageSize: value.pageSize })}
          >
            <X className="h-3.5 w-3.5" />
            清除篩選
          </Button>
        ) : null}
      </div>
    </div>
  );
}
