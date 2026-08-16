/**
 * 商品清單的篩選列。
 *
 * ⚠️ 這一列的每一個值都會被送到 server fn，篩選與分頁都在資料庫端做。來源是
 *    「抓全表 993 筆 → 前端 Array.filter → 全部渲染」，而且每一次寫入都重抓整張表。
 *
 * 「上架狀態」預設 active，與來源一致 —— 停用的商品平常不該擋在路中間。
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
import { INV_PRODUCT_TYPES, INV_PRODUCT_TYPE_LABELS, type ProductFilterValues } from "@/lib/admin/schemas";
import type { AdminCategory, AdminVendor } from "@/server/repos/inv-products";

/** Radix Select 不接受空字串當 value，所以「全部」用這個哨兵值。 */
const ALL = "__all__";

type Props = {
  value: ProductFilterValues;
  onChange: (next: ProductFilterValues) => void;
  categories: AdminCategory[];
  vendors: AdminVendor[];
  disabled?: boolean;
  pendingCount: number;
};

export function ProductFilterBar({
  value,
  onChange,
  categories,
  vendors,
  disabled,
  pendingCount,
}: Props) {
  // 任何一個篩選條件變動都要回到第一頁 —— 停在第 5 頁然後換一個只有 3 頁結果的
  // 條件，畫面會是空的，而使用者看到的是「沒有資料」而不是「你在第 5 頁」。
  function set(patch: Partial<ProductFilterValues>) {
    onChange({ ...value, ...patch, page: 0 });
  }

  const hasFilters =
    value.keyword !== null ||
    value.categoryId !== null ||
    value.productType !== null ||
    value.vendorId !== null ||
    value.approvalStatus !== "all" ||
    value.activeStatus !== "active" ||
    value.priceChange !== "all";

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="product-search" className="text-xs">
            搜尋
          </Label>
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="product-search"
              className="pl-8"
              placeholder="商品名稱、期數、條碼、系列、出版社"
              value={value.keyword ?? ""}
              disabled={disabled}
              onChange={(e) => set({ keyword: e.target.value.trim() === "" ? null : e.target.value })}
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
          <Label className="text-xs">類型</Label>
          <Select
            value={value.productType ?? ALL}
            disabled={disabled}
            onValueChange={(v) =>
              set({ productType: v === ALL ? null : (v as ProductFilterValues["productType"]) })
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
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">審核狀態</Label>
          <Select
            value={value.approvalStatus}
            disabled={disabled}
            onValueChange={(v) => set({ approvalStatus: v as ProductFilterValues["approvalStatus"] })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部狀態</SelectItem>
              <SelectItem value="pending">待審核{pendingCount > 0 ? `（${pendingCount}）` : ""}</SelectItem>
              <SelectItem value="approved">已審核</SelectItem>
              <SelectItem value="rejected">已退回</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">上架狀態</Label>
          <Select
            value={value.activeStatus}
            disabled={disabled}
            onValueChange={(v) => set({ activeStatus: v as ProductFilterValues["activeStatus"] })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">上架中</SelectItem>
              <SelectItem value="inactive">已停用</SelectItem>
              <SelectItem value="all">全部</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">調價</Label>
          <Select
            value={value.priceChange}
            disabled={disabled}
            onValueChange={(v) => set({ priceChange: v as ProductFilterValues["priceChange"] })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="pending">調價待審</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">排序</Label>
          <Select
            value={value.sort}
            disabled={disabled}
            onValueChange={(v) => set({ sort: v as ProductFilterValues["sort"] })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="created_at">最新建立</SelectItem>
              <SelectItem value="name_asc">名稱 A→Z</SelectItem>
              <SelectItem value="name_desc">名稱 Z→A</SelectItem>
              <SelectItem value="issue_asc">期數由小到大</SelectItem>
              <SelectItem value="issue_desc">期數由大到小</SelectItem>
              <SelectItem value="stock_asc">庫存由少到多</SelectItem>
              <SelectItem value="stock_desc">庫存由多到少</SelectItem>
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
                categoryId: null,
                productType: null,
                vendorId: null,
                approvalStatus: "all",
                activeStatus: "active",
                priceChange: "all",
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
