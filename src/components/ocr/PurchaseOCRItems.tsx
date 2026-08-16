/**
 * 進貨單辨識的確認表：逐列改、逐列決定要綁到哪一件既有商品。
 *
 * ── 為什麼每一列都要能自己選商品 ──────────────────────────────────────────
 * 自動比對（lib/admin/ocr-match.ts）刻意保守：期數或系列只要讀到了就一定要比對
 * 得上，否則寧可回 null 標成「新建商品」。所以「對不到」會比來源常見一點 —— 代價
 * 就是這一欄下拉選單。選錯一次是店員看得見的，綁錯一次是沒有人看得見的。
 *
 * 下拉裡的候選由 ocrMatchCandidates() 在瀏覽器算（不打伺服器），期數對不上的會
 * 排到後面但仍然列出來：那是給人判斷的，不是系統替他決定的。
 */
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { describeProduct, ocrMatchCandidates } from "@/lib/admin/ocr-match";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

/** Radix Select 不收空字串當 value。 */
const NEW_PRODUCT = "__new__";

export type OcrPurchaseRow = {
  /** React key，不會送到 server。 */
  key: string;
  selected: boolean;
  /** null = 這一列會建立一件新商品。 */
  product_id: string | null;
  name: string;
  issue_number: string;
  series: string;
  quantity: string;
  unit_cost: string;
};

type Props = {
  rows: OcrPurchaseRow[];
  onRowsChange: (next: OcrPurchaseRow[]) => void;
  products: ProductPickerRow[];
};

export function PurchaseOCRItems({ rows, onRowsChange, products }: Props) {
  function patch(key: string, next: Partial<OcrPurchaseRow>) {
    onRowsChange(rows.map((r) => (r.key === key ? { ...r, ...next } : r)));
  }

  return (
    <div className="max-h-80 overflow-y-auto rounded-md border border-border">
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
            <TableHead className="min-w-52">商品名稱 / 期數 / 系列</TableHead>
            <TableHead className="w-20">數量</TableHead>
            <TableHead className="w-24">單價</TableHead>
            <TableHead className="min-w-48">對應既有商品</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const candidates = ocrMatchCandidates(products, {
              name: row.name,
              issue_number: row.issue_number.trim() || null,
              series: row.series.trim() || null,
            });
            // 已綁定但不在候選裡（店員手動選的、或改了名稱之後候選變了）也要留著，
            // 否則 Select 會顯示空白，看起來像「綁定被清掉了」。
            const bound = row.product_id
              ? products.find((p) => p.inv_product_id === row.product_id)
              : undefined;
            const options =
              bound && !candidates.some((c) => c.inv_product_id === bound.inv_product_id)
                ? [bound, ...candidates]
                : candidates;

            return (
              <TableRow key={row.key} className={row.selected ? undefined : "opacity-50"}>
                <TableCell className="align-top">
                  <Checkbox
                    checked={row.selected}
                    onCheckedChange={(v) => patch(row.key, { selected: v === true })}
                    aria-label={`選取 ${row.name}`}
                  />
                </TableCell>

                <TableCell className="space-y-1.5 align-top">
                  <Input
                    value={row.name}
                    maxLength={200}
                    onChange={(e) => patch(row.key, { name: e.target.value })}
                    aria-label="商品名稱"
                    placeholder="商品名稱"
                  />
                  <div className="flex gap-1.5">
                    <Input
                      value={row.issue_number}
                      maxLength={50}
                      onChange={(e) => patch(row.key, { issue_number: e.target.value })}
                      aria-label="期數"
                      placeholder="期數"
                      className="h-8 text-xs"
                    />
                    <Input
                      value={row.series}
                      maxLength={200}
                      onChange={(e) => patch(row.key, { series: e.target.value })}
                      aria-label="系列"
                      placeholder="系列"
                      className="h-8 text-xs"
                    />
                  </div>
                </TableCell>

                <TableCell className="align-top">
                  <Input
                    type="number"
                    min={1}
                    value={row.quantity}
                    onChange={(e) => patch(row.key, { quantity: e.target.value })}
                    aria-label="數量"
                    className="text-right tabular-nums"
                  />
                </TableCell>

                <TableCell className="align-top">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={row.unit_cost}
                    onChange={(e) => patch(row.key, { unit_cost: e.target.value })}
                    aria-label="單價"
                    className="text-right tabular-nums"
                  />
                </TableCell>

                <TableCell className="space-y-1.5 align-top">
                  <Select
                    value={row.product_id ?? NEW_PRODUCT}
                    onValueChange={(v) =>
                      patch(row.key, { product_id: v === NEW_PRODUCT ? null : v })
                    }
                  >
                    <SelectTrigger aria-label="對應既有商品">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NEW_PRODUCT}>建立新商品</SelectItem>
                      {options.map((p) => (
                        <SelectItem key={p.inv_product_id} value={p.inv_product_id}>
                          {describeProduct(p)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {row.product_id ? (
                    <Badge variant="secondary" className="font-normal">
                      既有商品
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="font-normal text-primary">
                      新建商品
                    </Badge>
                  )}
                  {options.length === 0 && !row.product_id ? (
                    <p className="text-xs text-muted-foreground">庫存裡沒有相近的品項</p>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
