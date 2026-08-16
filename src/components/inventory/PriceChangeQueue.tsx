/**
 * 調價待審清單。
 *
 * 這一區存在的理由：一件商品的**商品本身**是已審核的，只有它的價格在等 ——
 * 所以它不會出現在「待審核」那個篩選裡。沒有這一區的話，一筆送出去的調價會
 * 靜靜地躺在資料庫裡，送的人以為在等，審的人根本不知道有東西要審。
 *
 * ⚠️ canApprove 只控制按鈕的 disabled。真正擋人的是 server 端的
 *    approve_price_changes 檢查（見 lib/admin/fns/inv-products.ts）。
 */
import { Button } from "@/components/ui/button";
import type { AdminProductRow } from "@/server/repos/inv-products";

type Props = {
  rows: AdminProductRow[];
  busyId: string | null;
  canApprove: boolean;
  onDecide: (row: AdminProductRow, approved: boolean) => void;
};

export function PriceChangeQueue({ rows, busyId, canApprove, onDecide }: Props) {
  const pending = rows.filter((r) => r.price_change_status === "pending");
  if (pending.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-sm font-medium">本頁有調價等待審核</p>
      <ul className="space-y-1.5">
        {pending.map((r) => (
          <li key={r.inv_product_id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{r.name}</span>
            <span className="text-muted-foreground">
              NT$ {Number(r.selling_price ?? 0).toLocaleString("zh-TW")} → NT${" "}
              {Number(r.pending_selling_price ?? 0).toLocaleString("zh-TW")}
              {r.price_change_requested_by_name ? `・${r.price_change_requested_by_name}` : ""}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10"
              disabled={busyId === r.inv_product_id || !canApprove}
              title={canApprove ? undefined : "需要「approve_price_changes」權限"}
              onClick={() => onDecide(r, true)}
            >
              核准調價
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-destructive/40 text-destructive hover:bg-destructive/10"
              disabled={busyId === r.inv_product_id || !canApprove}
              title={canApprove ? undefined : "需要「approve_price_changes」權限"}
              onClick={() => onDecide(r, false)}
            >
              退回
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
