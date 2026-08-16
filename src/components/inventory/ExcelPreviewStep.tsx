/**
 * Excel 匯入的第三步：預覽與逐列勾選。
 *
 * 這一步存在的理由是「解析摘要」那一區：來源系統把跳過的列與合併的列**默默吞掉**，
 * 匯入完成之後只說「成功 N 筆」，沒有人會發現進貨單上有 12 列因為名稱欄對錯而
 * 整列被丟掉。這裡把跳過幾列、為什麼跳過、原始內容長什麼樣都列出來。
 *
 * 「更新既有 / 新增」的標記也在這一步。同一本書進第二批貨時應該是更新，不是變成
 * 兩筆商品 —— 而那個判斷（lib/admin/excel-import.ts 的五級比對）猜錯的話，這裡是
 * 唯一看得出來的地方。
 */
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { INV_PRODUCT_TYPES, INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";
import type { ParsedRow, SkippedRow } from "@/lib/admin/excel-import";
import type { AdminCategory } from "@/server/repos/inv-products";

const NONE = "__none__";

export type ImportOptions = {
  create_purchase_record: boolean;
  category_id: string;
  product_type: (typeof INV_PRODUCT_TYPES)[number];
  vendor: string;
  purchase_date: string;
};

type Props = {
  rows: ParsedRow[];
  onRowsChange: (next: ParsedRow[]) => void;
  skipped: SkippedRow[];
  merged: number;
  options: ImportOptions;
  onOptionsChange: (next: ImportOptions) => void;
  categories: AdminCategory[];
  productApprovalOn: boolean;
};

export function ExcelPreviewStep({
  rows,
  onRowsChange,
  skipped,
  merged,
  options,
  onOptionsChange,
  categories,
  productApprovalOn,
}: Props) {
  const selectedCount = rows.filter((r) => r.selected).length;

  return (
    <div className="space-y-4">
      {skipped.length > 0 || merged > 0 ? (
        <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-amber-800">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            解析摘要
          </p>
          {skipped.length > 0 ? (
            <p className="text-xs">• {skipped.length} 列因商品名稱為空被跳過</p>
          ) : null}
          {merged > 0 ? <p className="text-xs">• {merged} 列與前面重複，數量已合併</p> : null}
          {skipped.length > 0 && skipped.length <= 10 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {skipped.map((s) => (
                <li key={s.rowNumber}>
                  第 {s.rowNumber} 列：{s.raw}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">套用分類</Label>
          <Select
            value={options.category_id || NONE}
            onValueChange={(v) => onOptionsChange({ ...options, category_id: v === NONE ? "" : v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不指定分類</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.category_id} value={c.category_id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">套用商品類型</Label>
          <Select
            value={options.product_type}
            onValueChange={(v) =>
              onOptionsChange({ ...options, product_type: v as (typeof INV_PRODUCT_TYPES)[number] })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INV_PRODUCT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {INV_PRODUCT_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 sm:col-span-2">
          <Checkbox
            id="imp-purchase"
            checked={options.create_purchase_record}
            onCheckedChange={(v) =>
              onOptionsChange({ ...options, create_purchase_record: v === true })
            }
          />
          <Label htmlFor="imp-purchase" className="font-normal">
            一起建立進貨記錄（庫存由進貨加上去，而不是直接寫數字）
          </Label>
        </div>

        {options.create_purchase_record ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="imp-vendor" className="text-xs">
                供應商（文字）
              </Label>
              <Input
                id="imp-vendor"
                value={options.vendor}
                maxLength={200}
                onChange={(e) => onOptionsChange({ ...options, vendor: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="imp-date" className="text-xs">
                進貨日期
              </Label>
              <Input
                id="imp-date"
                type="date"
                value={options.purchase_date}
                onChange={(e) => onOptionsChange({ ...options, purchase_date: e.target.value })}
              />
            </div>
          </>
        ) : null}
      </div>

      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={rows.length > 0 && rows.every((r) => r.selected)}
                  onCheckedChange={(v) =>
                    onRowsChange(rows.map((r) => ({ ...r, selected: v === true })))
                  }
                  aria-label="全選"
                />
              </TableHead>
              <TableHead>商品名稱</TableHead>
              <TableHead className="w-20">期數</TableHead>
              <TableHead className="w-24 text-right">售價</TableHead>
              <TableHead className="w-20 text-right">數量</TableHead>
              <TableHead className="w-28">狀態</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell>
                  <Checkbox
                    checked={r.selected}
                    onCheckedChange={(v) =>
                      onRowsChange(
                        rows.map((x) => (x.key === r.key ? { ...x, selected: v === true } : x)),
                      )
                    }
                    aria-label={`選取 ${r.name}`}
                  />
                </TableCell>
                <TableCell>
                  <div className="space-y-0.5">
                    <p className="text-sm">{r.name}</p>
                    {r.barcode ? (
                      <p className="font-mono text-xs text-muted-foreground">{r.barcode}</p>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-sm tabular-nums">{r.issue_number ?? "—"}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {r.selling_price.toLocaleString("zh-TW")}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">{r.quantity}</TableCell>
                <TableCell>
                  {r.existing_product_id ? (
                    <Badge variant="secondary" className="gap-1 font-normal">
                      <RefreshCw className="h-3 w-3" aria-hidden="true" />
                      更新既有
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="font-normal">
                      新增
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        已選 {selectedCount} / {rows.length} 列。
        {productApprovalOn ? "新增的商品會進入待審核。" : "審核已關閉，新增的商品會直接生效。"}
      </p>
    </div>
  );
}
