/**
 * 分攤口徑徽章 + 那句「把售價補齊就會換口徑」的提示。
 *
 * 為什麼要把這件事放到畫面上：一個套餐只有一個組合價，賣掉的時候它要被拆成每一件
 * 組成品項各自的營收。拆法有兩種，而**店員選不了** —— 0018 §4 看的是「有沒有哪一件
 * 沒填售價」，缺一件整組就退回按數量均分。正式庫現在三個上架中的套餐全部都是這個
 * 狀態，所以這是常態不是邊角案例。不寫出來的話，「為什麼這本書這個月營收怪怪的」
 * 沒有人答得出來。
 */
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { basisMeta } from "@/lib/admin/inv-combo-labels";

type Props = {
  basis: "list_price" | "quantity" | null;
  /** 沒有定價的品項數。只有 quantity 口徑時才有意義。 */
  zeroPricedItems?: number;
  className?: string;
};

export function ComboSetBasisBadge({ basis, className }: Props) {
  const meta = basisMeta(basis);
  return (
    <Badge
      variant={meta.variant}
      className={`font-normal ${className ?? ""}`}
      title={meta.description}
    >
      {meta.label}
    </Badge>
  );
}

/** quantity 口徑時的一句話提示。其他口徑不畫東西 —— 沒事的時候不要說話。 */
export function ComboSetBasisHint({ basis, zeroPricedItems }: Props) {
  if (basis !== "quantity") return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        有 {zeroPricedItems ?? 0} 件組成品項沒有填售價，所以整組退回按數量均分。
        到商品管理把它們的售價補齊，這個套餐就會自動改成依定價比例分攤。
      </span>
    </p>
  );
}
