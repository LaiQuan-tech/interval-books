/**
 * 進貨清單篩選列的第二排：審核／效期／庫存狀態、日期區間、排序、每頁筆數、清除。
 *
 * 從 PurchaseFilterBar 抽出來：那個檔案原本是「兩排篩選 ＋ 哨兵值 ＋ 清除判斷」擠在
 * 一起，剛好 300 行，正是自檢那條上限的零餘裕位置 —— 之後任何一個新條件都會越線。
 * 第一排是「找哪一批貨」（關鍵字、分類、供應商、類型），這一排是「用狀態縮小範圍」，
 * 兩者各自會變動。
 *
 * ⚠️ 「效期狀態」在資料庫端只能用固定的 30 天上界撈（PostgREST 沒辦法拿一個欄位去
 *    比另一個欄位），真正 per-row 的 expiry_alert_days 判斷在表格那一層。文案因此
 *    寫「即將到期」而不是「N 天內到期」—— 每一列的門檻本來就不一樣。
 *
 * ⚠️ 「清除篩選」刻意**留著 sort 與 pageSize**：那兩個是使用者對版面的偏好，不是
 *    篩選條件，一起清掉會讓人以為畫面壞了。
 */
import { X } from "lucide-react";
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
import type { PurchaseFilterValues } from "@/lib/admin/schemas";

const PAGE_SIZES = [25, 50, 100, 200];

type Props = {
  value: PurchaseFilterValues;
  defaults: PurchaseFilterValues;
  disabled?: boolean;
  onChange: (next: PurchaseFilterValues) => void;
  /** 套用一組部分條件（PurchaseFilterBar 那邊會順便把 page 歸零）。 */
  onPatch: (patch: Partial<PurchaseFilterValues>) => void;
};

export function PurchaseStatusFilters({ value, defaults, disabled, onChange, onPatch }: Props) {
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
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label className="text-xs">審核狀態</Label>
        <Select
          value={value.approvalStatus}
          disabled={disabled}
          onValueChange={(v) =>
            onPatch({ approvalStatus: v as PurchaseFilterValues["approvalStatus"] })
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
          onValueChange={(v) =>
            onPatch({ expiryStatus: v as PurchaseFilterValues["expiryStatus"] })
          }
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
          onValueChange={(v) => onPatch({ stockStatus: v as PurchaseFilterValues["stockStatus"] })}
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
          onChange={(e) => onPatch({ dateFrom: e.target.value || null })}
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
          onChange={(e) => onPatch({ dateTo: e.target.value || null })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">排序</Label>
        <Select
          value={value.sort}
          disabled={disabled}
          onValueChange={(v) => onPatch({ sort: v as PurchaseFilterValues["sort"] })}
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
          onValueChange={(v) => onPatch({ pageSize: Number(v) })}
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
  );
}
