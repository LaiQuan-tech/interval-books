/**
 * 「賣掉一份的話，這筆錢會怎麼分」的預覽表。
 *
 * ⚠️ **這只是預覽**。真正寫進 inv.sales.amount 的金額一律由
 *    inv.allocate_combo_amounts() / inv_combo_checkout() 在資料庫裡算 —— 這張表算出
 *    來的數字不會、也不該被送到 server。演算法在 lib/admin/combo-allocation.ts，
 *    那個檔案的檔頭寫了它必須與 0018 §3 保持同步。
 *
 * 為什麼還是要畫：組合價 200 元、三本書的套餐，店員在按下儲存之前唯一想知道的事就是
 * 「那這本書會被記多少營收」。等賣完再去看報表才發現分錯，帳已經進去了。
 */
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ComboSetBasisBadge, ComboSetBasisHint } from "@/components/inventory/ComboSetBasisBadge";
import { previewComboAllocation, type AllocationInput } from "@/lib/admin/combo-allocation";
import { money } from "@/lib/admin/inv-combo-labels";

export type PreviewItem = AllocationInput & { name: string; issue_number: string | null };

type Props = {
  sellingPrice: number;
  items: PreviewItem[];
};

export function ComboSetAllocationPreview({ sellingPrice, items }: Props) {
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        還沒有組成品項，所以算不出分攤。沒有組成品項的套餐也賣不出去 —— 資料庫會擋下來。
      </p>
    );
  }

  const preview = previewComboAllocation(sellingPrice, items);
  const byId = new Map(items.map((i) => [i.product_id, i]));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">分攤預覽</p>
        <ComboSetBasisBadge basis={preview.basis} />
        <Badge variant="outline" className="font-normal text-muted-foreground">
          合計 {money(preview.total)}
        </Badge>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-40">組成品項</TableHead>
              <TableHead className="w-16 text-right">數量</TableHead>
              <TableHead className="w-24 text-right">定價</TableHead>
              <TableHead className="w-28 text-right">分攤金額</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.rows.map((row) => {
              const item = byId.get(row.product_id);
              const price = row.selling_price ?? 0;
              return (
                <TableRow key={row.product_id}>
                  <TableCell className="text-sm">
                    {item?.name ?? "未知商品"}
                    {item?.issue_number ? (
                      <span className="text-muted-foreground"> #{item.issue_number}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{row.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {price > 0 ? (
                      money(price)
                    ) : (
                      <span className="text-amber-700" title="這件商品沒有填售價">
                        未填
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums text-sm">
                    {money(row.amount)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ComboSetBasisHint basis={preview.basis} zeroPricedItems={preview.zeroPricedCount} />

      <p className="text-xs text-muted-foreground">
        以上是預覽，實際入帳金額由資料庫在結帳當下計算（最大餘額法，加總必等於組合價）。
      </p>
    </div>
  );
}
