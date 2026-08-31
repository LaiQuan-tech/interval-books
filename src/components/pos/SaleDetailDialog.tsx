import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import type { PosSaleRow } from "@/server/repos/inv-sales";

/**
 * 一筆銷售的明細。
 *
 * ⚠️ 這個對話框**不再打一次資料庫**。來源系統點開明細會重新 query 一次商品與
 *    付款方式，而那兩個欄位在列表 query 裡已經 join 過了 —— 那一次來回只是把
 *    同樣的資料再抓一遍。inv_pos_sales 這個 view 一次給齊，列表拿到什麼，這裡
 *    就顯示什麼。
 */
type Props = {
  sale: PosSaleRow | null;
  onOpenChange: (open: boolean) => void;
};

function money(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  return `NT$ ${Number(n).toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
}

export function SaleDetailDialog({ sale, onOpenChange }: Props) {
  return (
    <Dialog open={sale !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {sale ? (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6 text-base">
                {sale.product_name ?? "（無品名）"}
              </DialogTitle>
              <DialogDescription>
                {sale.sale_date}
                {sale.created_at
                  ? `　${new Date(sale.created_at).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit" })}`
                  : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-1.5">
              <Badge
                variant={sale.channel === "online" ? "default" : "secondary"}
                className="font-normal"
              >
                {sale.channel === "online" ? "網站訂單" : "門市"}
              </Badge>
              {sale.override_reservation ? (
                <Badge variant="destructive" className="font-normal">
                  強制放行
                </Badge>
              ) : null}
              {sale.is_secondhand ? (
                <Badge variant="outline" className="font-normal">
                  二手
                </Badge>
              ) : null}
              {sale.is_reconciled ? (
                <Badge variant="outline" className="font-normal">
                  已對帳
                </Badge>
              ) : null}
            </div>

            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">系列／期數</dt>
              <dd>{[sale.series, sale.issue_number].filter(Boolean).join("　") || "—"}</dd>

              <dt className="text-muted-foreground">數量</dt>
              <dd className="tabular-nums">{sale.quantity}</dd>

              <dt className="text-muted-foreground">單價</dt>
              <dd className="tabular-nums">{money(sale.unit_price)}</dd>

              <dt className="text-muted-foreground">小計</dt>
              <dd className="tabular-nums font-medium">{money(sale.amount)}</dd>

              <Separator className="col-span-2 my-1" />

              <dt className="text-muted-foreground">單位成本</dt>
              <dd className="tabular-nums">
                {sale.cost_price === null ? (
                  <span className="text-muted-foreground">未分攤（搬遷前的資料）</span>
                ) : (
                  money(sale.cost_price)
                )}
              </dd>

              <dt className="text-muted-foreground">毛利</dt>
              <dd className="tabular-nums">
                {sale.gross_profit === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  money(sale.gross_profit)
                )}
              </dd>

              <Separator className="col-span-2 my-1" />

              <dt className="text-muted-foreground">付款方式</dt>
              <dd>{sale.payment_method_name ?? "—"}</dd>

              <dt className="text-muted-foreground">操作人員</dt>
              <dd>{sale.operator_name ?? "—"}</dd>

              {sale.web_order_id ? (
                <>
                  <dt className="text-muted-foreground">網站訂單</dt>
                  <dd className="break-all font-mono text-xs">{sale.web_order_id}</dd>
                </>
              ) : null}

              <dt className="text-muted-foreground">備註</dt>
              <dd className="whitespace-pre-wrap">{sale.notes || "—"}</dd>
            </dl>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
