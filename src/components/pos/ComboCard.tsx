/**
 * 一張可販售的套餐卡。
 *
 * ⚠️ 這張卡上**所有數字都是唯讀的**。組合價、還能組幾份、分攤口徑全部來自
 *    0018 的 inv_admin_combo_sets view，不是在瀏覽器算的。店員能決定的只有
 *    「賣哪一組、賣幾份」，其餘由 inv_combo_checkout() 在資料庫裡算完才寫進
 *    inv.sales —— 見 0018 檔頭問題一（來源是在瀏覽器裡決定哪一件商品拿到全部
 *    營收，那正是寄賣廠商的拆帳基礎）。
 */
import { Layers, PackageCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { basisLabel } from "@/components/pos/combo-basis";
import type { AdminComboItemRow, AdminComboSetRow } from "@/server/repos/inv-combos";

type Props = {
  set: AdminComboSetRow;
  /** 這一組的組成品項（呼叫端已用 combo_set_id 過濾好）。 */
  items: AdminComboItemRow[];
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
};

export function ComboCard({ set, items, selected, onSelect, disabled }: Props) {
  const maxSets = set.max_sets;
  // max_sets 是 null 代表這組沒有組成品項（view 沒得取 min），不是「無限」。
  const soldOut = maxSets !== null && maxSets <= 0;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
        className={`w-full rounded-md border p-3 text-left transition-colors ${
          selected
            ? "border-primary bg-primary/5"
            : "border-border hover:bg-muted/60 focus-visible:bg-muted/60"
        } focus-visible:outline-none disabled:opacity-60`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{set.name}</p>
            {set.notes ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{set.notes}</p>
            ) : null}
          </div>
          <span className="shrink-0 text-right">
            <span className="block text-sm font-medium tabular-nums">
              NT$ {Number(set.selling_price).toLocaleString("zh-TW")}
            </span>
            <span className="block text-xs text-muted-foreground">組合價</span>
          </span>
        </div>

        <ul className="mt-2 space-y-0.5">
          {items.length === 0 ? (
            <li className="text-xs text-muted-foreground">（這組還沒有組成品項）</li>
          ) : (
            items.map((item) => (
              <li
                key={item.item_id}
                className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground"
              >
                <span className="min-w-0 flex-1 truncate">
                  {item.issue_number
                    ? `${item.product_name} #${item.issue_number}`
                    : item.product_name}
                  {item.quantity > 1 ? ` ×${item.quantity}` : ""}
                </span>
                <span className="shrink-0 tabular-nums">
                  定價 NT$ {Number(item.selling_price).toLocaleString("zh-TW")}
                </span>
              </li>
            ))
          )}
        </ul>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge
            variant={soldOut ? "destructive" : "secondary"}
            className="gap-1 font-normal tabular-nums"
          >
            <PackageCheck className="h-3 w-3" aria-hidden="true" />
            還能組 {maxSets === null ? "—" : maxSets} 份
          </Badge>
          <Badge variant="outline" className="gap-1 font-normal">
            <Layers className="h-3 w-3" aria-hidden="true" />
            {basisLabel(set.allocation_basis)}
          </Badge>
          {set.zero_priced_items > 0 ? (
            <span className="text-xs text-muted-foreground">
              有 {set.zero_priced_items} 件沒有定價，所以整組按數量均分
            </span>
          ) : null}
        </div>
      </button>
    </li>
  );
}
