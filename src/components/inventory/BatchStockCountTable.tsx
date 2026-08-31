/**
 * 批次盤點的商品表：勾選、填實際數量、看預估差異。
 *
 * 從 BatchStockCountDialog 抽出來：那個檔案原本是「對話框外殼 ＋ 搜尋 ＋ 表 ＋ 統計 ＋
 * 送出」擠在一起，長到剛好卡在自檢的 300 行上限，連 prettier 都套不上去（折行會讓它
 * 超過）。
 *
 * ⚠️ 「預估差異」只是給人看的參考值。送出去的是**實盤數量**，差異由資料庫用送出當下
 *    的 stock_quantity 算 —— 理由見 BatchStockCountDialog 檔頭。
 *
 * ⚠️ picked 連 row 一起存**不是**多此一舉，見 BatchStockCountDialog 裡那個 state 的說明。
 */
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { StockCountProductRow } from "@/server/repos/inv-adjustments";

/** key 存在 = 已勾選；value 是輸入框裡的字串（空字串 = 勾了但還沒數到）。 */
export type BatchCountPicked = Record<string, { row: StockCountProductRow; value: string }>;

type Props = {
  rows: StockCountProductRow[];
  loading: boolean;
  picked: BatchCountPicked;
  onToggle: (row: StockCountProductRow) => void;
  onValueChange: (id: string, value: string) => void;
};

export function BatchStockCountTable({ rows, loading, picked, onToggle, onValueChange }: Props) {
  return (
    <div className="max-h-72 overflow-y-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead className="min-w-48">商品</TableHead>
            <TableHead className="w-24 text-right">帳面庫存</TableHead>
            <TableHead className="w-32 text-right">實際數量</TableHead>
            <TableHead className="w-28 text-right">預估差異</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading || rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                {loading ? "載入中…" : "沒有找到符合的商品"}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const raw = picked[row.inv_product_id]?.value;
              const checked = row.inv_product_id in picked;
              const actual = raw !== undefined && raw.trim() !== "" ? Number(raw) : null;
              const diff =
                actual === null || Number.isNaN(actual) ? null : actual - row.stock_quantity;
              return (
                <TableRow key={row.inv_product_id} className={checked ? "bg-muted/30" : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => onToggle(row)}
                      aria-label={`選取 ${row.name}`}
                    />
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.name}
                    {row.issue_number ? (
                      <span className="text-muted-foreground"> #{row.issue_number}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.stock_quantity}</TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      className="ml-auto h-8 w-24 text-right"
                      placeholder="輸入數量"
                      disabled={!checked}
                      value={raw ?? ""}
                      onChange={(e) => onValueChange(row.inv_product_id, e.target.value)}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {diff === null || diff === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={
                          diff < 0 ? "font-medium text-destructive" : "font-medium text-emerald-700"
                        }
                      >
                        {diff > 0 ? "+" : ""}
                        {diff}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
