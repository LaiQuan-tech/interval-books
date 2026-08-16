/**
 * 進貨 Excel 匯入的第三步：預覽、逐列勾選、設定四個預設值。
 *
 * ── 「被跳過的列」一定要看得到 ────────────────────────────────────────────
 * 來源把跳過的列**默默吞掉**，匯完只說「成功 N 筆」—— 進貨單上有 12 列因為數量欄
 * 對錯而整列消失，沒有人會發現。這裡把跳過幾列、第幾列、為什麼、原始內容都列出來
 * （超過 10 列只列前 10 列，但總數還是講）。
 *
 * ── 「既有商品 / 新建商品」的標記也在這一步 ───────────────────────────────
 * 比對猜錯的話（purchase-import.ts 的三級比對），這裡是唯一看得出來的地方：一本
 * 已經在庫存裡的書被標成「新建商品」，匯完就會多出一件重複商品。
 */
import { AlertTriangle } from "lucide-react";
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
import type { ParsedPurchaseRow, SkippedPurchaseRow } from "@/lib/admin/purchase-import";
import type { VendorOption } from "@/components/inventory/VendorSelect";

const NONE = "__none__";

/**
 * 四個預設值。⚠️ 預設供應商只能是**名單上的**供應商（importPurchasesSchema 的
 * default_vendor_id 是 uuid）—— 自由文字的供應商要寫在 Excel 的供應商欄裡。
 */
export type PurchaseImportOptions = {
  default_vendor_id: string;
  default_category_id: string;
  default_purchase_date: string;
  default_expiry_alert_days: string;
};

type Props = {
  rows: ParsedPurchaseRow[];
  onRowsChange: (next: ParsedPurchaseRow[]) => void;
  skipped: SkippedPurchaseRow[];
  merged: number;
  options: PurchaseImportOptions;
  onOptionsChange: (next: PurchaseImportOptions) => void;
  categories: { category_id: string; name: string }[];
  vendors: VendorOption[];
  approvalOn: boolean;
};

export function PurchasePreviewStep({
  rows,
  onRowsChange,
  skipped,
  merged,
  options,
  onOptionsChange,
  categories,
  vendors,
  approvalOn,
}: Props) {
  const selectedCount = rows.filter((r) => r.selected).length;
  const newProducts = rows.filter((r) => r.selected && !r.product_id).length;

  return (
    <div className="space-y-4">
      {skipped.length > 0 || merged > 0 ? (
        <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-amber-800">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            解析摘要
          </p>
          {skipped.length > 0 ? <p className="text-xs">• {skipped.length} 列被跳過</p> : null}
          {merged > 0 ? <p className="text-xs">• {merged} 列與前面重複，數量已合併</p> : null}
          {skipped.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {skipped.slice(0, 10).map((s) => (
                <li key={s.rowNumber}>
                  第 {s.rowNumber} 列（{s.reason}）：{s.raw}
                </li>
              ))}
              {skipped.length > 10 ? <li>…還有 {skipped.length - 10} 列</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">預設供應商（Excel 沒填時套用）</Label>
          <Select
            value={options.default_vendor_id || NONE}
            onValueChange={(v) =>
              onOptionsChange({ ...options, default_vendor_id: v === NONE ? "" : v })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不指定</SelectItem>
              {vendors.map((v) => (
                <SelectItem key={v.vendor_id} value={v.vendor_id}>
                  {v.short_name || v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">預設分類（新建商品用）</Label>
          <Select
            value={options.default_category_id || NONE}
            onValueChange={(v) =>
              onOptionsChange({ ...options, default_category_id: v === NONE ? "" : v })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不指定</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.category_id} value={c.category_id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pi-date" className="text-xs">
            預設進貨日期
          </Label>
          <Input
            id="pi-date"
            type="date"
            value={options.default_purchase_date}
            onChange={(e) => onOptionsChange({ ...options, default_purchase_date: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pi-alert" className="text-xs">
            預設效期警示天數
          </Label>
          <Input
            id="pi-alert"
            type="number"
            min={1}
            max={365}
            placeholder="7"
            value={options.default_expiry_alert_days}
            onChange={(e) =>
              onOptionsChange({ ...options, default_expiry_alert_days: e.target.value })
            }
          />
        </div>
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
              <TableHead>商品</TableHead>
              <TableHead className="w-20 text-right">數量</TableHead>
              <TableHead className="w-24 text-right">單價</TableHead>
              <TableHead className="w-28">供應商</TableHead>
              <TableHead className="w-28">進貨日期</TableHead>
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
                  <p className="text-sm">{r.name}</p>
                  {r.barcode ? (
                    <p className="font-mono text-xs text-muted-foreground">{r.barcode}</p>
                  ) : null}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">{r.quantity}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {r.unit_cost === null ? "—" : r.unit_cost.toLocaleString("zh-TW")}
                </TableCell>
                <TableCell className="text-xs">
                  {r.vendor_id
                    ? (vendors.find((v) => v.vendor_id === r.vendor_id)?.short_name ?? "已比對")
                    : r.vendor || <span className="text-muted-foreground">用預設</span>}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {r.purchase_date ?? <span className="text-muted-foreground">用預設</span>}
                </TableCell>
                <TableCell>
                  {r.product_id ? (
                    <Badge variant="secondary" className="font-normal">
                      既有商品
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="font-normal text-primary">
                      新建商品
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        已選 {selectedCount} / {rows.length} 列，其中 {newProducts} 列會建立新商品。
        {approvalOn ? "匯入的進貨會進入待審核。" : "審核已關閉，匯入的進貨會直接生效。"}
      </p>
    </div>
  );
}
