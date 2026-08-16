/**
 * 一個套餐最近的銷售紀錄，一個 combo_sale_group 一列（＝賣出去的一份）。
 *
 * ⚠️ 這張 view 的加總跨越了兩種分攤口徑：2026-08 之前是舊系統的「第一件吃全額」，
 *    之後是 0018 的比例分攤。**group 層級的合計兩者相同**，所以這裡的營收可以直接
 *    看；會不一樣的是逐品項的營收歸屬。
 *
 * 「今天」那顆徽章比對的是 todayInTaipei() —— sale_date 是 date 不是 timestamptz，
 * 用 UTC 比會在晚上 8 點之後整批對不上。
 */
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money } from "@/lib/admin/inv-combo-labels";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import type { AdminComboSaleRow } from "@/server/repos/inv-combos";

type Props = {
  rows: AdminComboSaleRow[];
  loading: boolean;
};

export function ComboSetSalesList({ rows, loading }: Props) {
  const today = todayInTaipei();

  if (loading) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md border border-border">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        這個套餐還沒有賣出過。
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-32">日期</TableHead>
            <TableHead className="w-20 text-right">品項數</TableHead>
            <TableHead className="w-24 text-right">營收</TableHead>
            <TableHead className="w-24 text-right">毛利</TableHead>
            <TableHead className="w-28">付款方式</TableHead>
            <TableHead className="w-24">操作人</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.sale_group}>
              <TableCell className="tabular-nums text-sm">
                <div className="flex items-center gap-1.5">
                  {row.sale_date}
                  {row.sale_date === today ? (
                    <Badge variant="secondary" className="font-normal">
                      今天
                    </Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums text-sm">{row.row_count}</TableCell>
              <TableCell className="text-right tabular-nums text-sm">
                {money(row.revenue)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-sm">
                {money(row.gross_profit)}
              </TableCell>
              <TableCell className="text-sm">{row.payment_method_name ?? "—"}</TableCell>
              <TableCell className="text-sm">{row.operator_name ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
