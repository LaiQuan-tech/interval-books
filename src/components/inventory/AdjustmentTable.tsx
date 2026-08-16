/**
 * 在庫異動清單。
 *
 * ⚠️ 數量的正負是有意義的：負的是扣帳（報廢、贈送、領用、盤虧），正的是回補
 *    （退貨入庫、盤盈、沖帳）。整站同一條配色規則：負紅、正綠。
 *
 * ⚠️ 「沖」那顆徽章看的是 `reversal_of`（這張單是**別人的沖帳單**）。另外一個方向的
 *    `reversed_by_id`（這張單**已經被沖過了**）在詳情裡才看得到，因為清單上兩個都印
 *    會分不清楚誰沖誰。
 */
import { Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  categoryLabel,
  categoryVariant,
  statusLabel,
  statusVariant,
} from "@/lib/admin/inv-adjustment-labels";
import type { AdminAdjustmentRow } from "@/server/repos/inv-adjustments";

type Props = {
  rows: AdminAdjustmentRow[];
  busyId: string | null;
  onView: (row: AdminAdjustmentRow) => void;
};

function money(n: number | null) {
  return n === null || n === undefined ? "—" : `NT$ ${Number(n).toLocaleString("zh-TW")}`;
}

export function AdjustmentTable({ rows, busyId, onView }: Props) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-36">單號</TableHead>
            <TableHead className="w-28">日期</TableHead>
            <TableHead className="min-w-48">商品</TableHead>
            <TableHead className="w-32">類別</TableHead>
            <TableHead className="w-24 text-right">數量</TableHead>
            <TableHead className="w-28 text-right">成本</TableHead>
            <TableHead className="w-24">狀態</TableHead>
            <TableHead className="w-28">建立者</TableHead>
            <TableHead className="w-16 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.adjustment_id}
              className={busyId === row.adjustment_id ? "opacity-60" : undefined}
            >
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs">{row.adjustment_number ?? "—"}</span>
                  {row.reversal_of ? (
                    <Badge variant="outline" className="font-normal">
                      沖
                    </Badge>
                  ) : null}
                </div>
              </TableCell>

              <TableCell className="tabular-nums text-sm">{row.adjustment_date}</TableCell>

              <TableCell>
                <div className="space-y-0.5">
                  <p className="text-sm">{row.product_name ?? "未知商品"}</p>
                  {row.issue_number || row.series ? (
                    <p className="text-xs text-muted-foreground">
                      {[row.series, row.issue_number ? `#${row.issue_number}` : null]
                        .filter(Boolean)
                        .join(" ・ ")}
                    </p>
                  ) : null}
                </div>
              </TableCell>

              <TableCell>
                <Badge variant={categoryVariant(row.category)} className="font-normal">
                  {categoryLabel(row.category)}
                </Badge>
              </TableCell>

              <TableCell className="text-right">
                <span
                  className={
                    row.quantity < 0
                      ? "font-medium tabular-nums text-destructive"
                      : "font-medium tabular-nums text-emerald-700"
                  }
                >
                  {row.quantity > 0 ? "+" : ""}
                  {row.quantity}
                </span>
              </TableCell>

              <TableCell className="text-right tabular-nums text-sm">{money(row.total_cost)}</TableCell>

              <TableCell>
                <Badge variant={statusVariant(row.status)} className="font-normal">
                  {statusLabel(row.status)}
                </Badge>
              </TableCell>

              <TableCell className="text-sm">{row.creator_name ?? "—"}</TableCell>

              <TableCell className="text-right">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  title="查看詳細"
                  onClick={() => onView(row)}
                >
                  <Eye className="h-4 w-4" />
                  <span className="sr-only">查看詳細</span>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
