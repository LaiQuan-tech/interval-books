/**
 * 賣完一份套餐之後，把「這 480 元怎麼變成三本書各自的營收」攤開給人看。
 *
 * ── 為什麼一定要有這一塊 ──────────────────────────────────────────────────
 * 套餐在 inv.sales 裡不是一列，是每個組成品項各一列（同一個 combo_sale_group）。
 * 分攤是 inv.allocate_combo_amounts() 算的，店員送出前看不到結果 —— 如果送出後
 * 也看不到，那「這本書這個月賣了多少」對寄賣廠商就是一個沒有人驗證過的數字。
 *
 * ⚠️ 這裡的每一個金額都是資料庫回來的，一個字都沒有重算。要對帳就對這一份。
 */
import { CheckCircle2, Layers } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { basisLabel } from "@/components/pos/combo-basis";
import type { AdminComboItemRow, ComboCheckoutResult } from "@/server/repos/inv-combos";

type Props = {
  result: ComboCheckoutResult;
  /** 這一組的組成品項，只拿來把 allocation 的 product_id 翻成書名。 */
  items: AdminComboItemRow[];
};

function money(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  return `NT$ ${Number(n).toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
}

export function ComboResultPanel({ result, items }: Props) {
  const nameOf = new Map(items.map((i) => [i.product_id, i.product_name]));
  const allocated = result.allocation.reduce((n, a) => n + Number(a.amount), 0);
  // 分攤總和理論上等於 total_amount。不等就是資料庫端的 round 差，直接顯示出來，
  // 不要靜默補到相等 —— 那會讓對帳的人永遠查不出差額從哪來。
  const drift = Number(result.total_amount) - allocated;

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
      <div>
        <p className="flex items-center gap-1.5 font-medium">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          已賣出「{result.combo_name}」{result.sets} 份
        </p>
        <p className="mt-1 flex items-baseline justify-between">
          <span className="text-muted-foreground">實收</span>
          <span className="text-lg font-medium tabular-nums">{money(result.total_amount)}</span>
        </p>
        <p className="flex items-baseline justify-between text-xs text-muted-foreground">
          <span>成本合計</span>
          <span className="tabular-nums">{money(result.total_cost)}</span>
        </p>
      </div>

      <Separator />

      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          分攤口徑：{basisLabel(result.basis)}
        </p>
        <ul className="space-y-1">
          {result.allocation.map((row) => (
            <li key={row.product_id} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-xs">
                {nameOf.get(row.product_id) ?? "（已刪除的商品）"}
                {row.quantity > 1 ? ` ×${row.quantity}` : ""}
              </span>
              <span className="shrink-0 tabular-nums text-xs font-medium">{money(row.amount)}</span>
            </li>
          ))}
        </ul>
        {Math.abs(drift) > 0.005 ? (
          <p className="text-xs text-muted-foreground">
            分攤合計 {money(allocated)}，與實收差 {money(drift)}（資料庫端的分位差）。
          </p>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {`寫進 inv.sales 共 ${result.allocation.length} 列，屬於 ${result.sale_groups.length} 個套餐批次。要查明細請到「銷售紀錄」。`}
      </p>
    </div>
  );
}
