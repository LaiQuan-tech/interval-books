/**
 * 審核狀態徽章。
 *
 * 來源的 ApprovalStatusBadge 在遇到不認得的值時 `return null` —— 於是一件
 * approval_status 是空字串或某個打錯的值的商品，畫面上看起來跟「已審核」一模一樣
 * （什麼都不顯示）。呼叫端只好到處寫 `status={x.approval_status || 'approved'}`，
 * 也就是把「不知道」預設成「通過」。
 *
 * 這裡反過來：認不出來就顯示出來（灰底、原樣印出那個值）。看到一個奇怪的徽章
 * 會有人來問；看不到任何東西不會。
 */
import { CheckCircle2, Clock, HelpCircle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type Props = { status: string | null | undefined; className?: string };

export function ApprovalStatusBadge({ status, className }: Props) {
  if (status === "approved") {
    return (
      <Badge
        variant="outline"
        className={`gap-1 border-emerald-600/30 font-normal text-emerald-700 ${className ?? ""}`}
      >
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        已審核
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge variant="destructive" className={`gap-1 font-normal ${className ?? ""}`}>
        <XCircle className="h-3 w-3" aria-hidden="true" />
        已退回
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge variant="secondary" className={`gap-1 font-normal ${className ?? ""}`}>
        <Clock className="h-3 w-3" aria-hidden="true" />
        待審核
      </Badge>
    );
  }
  // null = 這件事還沒發生過（例如從來沒有送過調價）。不畫東西是對的。
  if (status === null || status === undefined || status === "") return null;

  return (
    <Badge
      variant="outline"
      className={`gap-1 font-normal text-muted-foreground ${className ?? ""}`}
    >
      <HelpCircle className="h-3 w-3" aria-hidden="true" />
      {status}
    </Badge>
  );
}

/** 調價狀態。與審核狀態並排時要看得出來是「價格」在等，不是商品本身。 */
export function PriceChangeBadge({
  status,
  pendingPrice,
}: {
  status: string | null;
  pendingPrice: number | null;
}) {
  if (status !== "pending") return null;
  return (
    <Badge
      variant="secondary"
      className="gap-1 border-amber-500/30 bg-amber-500/10 font-normal text-amber-700"
    >
      <Clock className="h-3 w-3" aria-hidden="true" />
      調價待審{" "}
      {pendingPrice === null ? "" : `→ NT$ ${Number(pendingPrice).toLocaleString("zh-TW")}`}
    </Badge>
  );
}
