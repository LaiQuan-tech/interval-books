/**
 * 進貨的批次操作列。選取模式打開時出現。
 *
 * ⚠️ 批次審核只送**目前是 pending** 的那幾筆。不管原本狀態就整批覆寫的話，「全選 →
 *    批次通過」會把三個月前就通過的批次重寫成「今天某某人核准的」。
 *
 * ⚠️ 這裡沒有「批次刪除」。刪除會連庫存一起收回，而已經出過貨的批次會被 trigger
 *    擋下來 —— 一次刪 200 筆沒有辦法一筆筆看清楚哪一筆被擋、為什麼。
 *
 * ⚠️ 沿用 BatchActionBar 的版面但不共用元件：它的 tooltip 寫死「需要
 *    approve_products 權限」，進貨要的是 approve_purchases。權限名稱寫錯，人就會
 *    去要錯的權限。
 */
import { CheckCircle2, Loader2, PencilRuler, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  selectedCount: number;
  pendingCount: number;
  totalOnPage: number;
  canApprove: boolean;
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onBatchApprove: (approved: boolean) => void;
  onOpenBatchUpdate: () => void;
};

export function PurchaseBatchBar({
  selectedCount,
  pendingCount,
  totalOnPage,
  canApprove,
  busy,
  onSelectAll,
  onClear,
  onBatchApprove,
  onOpenBatchUpdate,
}: Props) {
  const blockedTitle = canApprove ? undefined : "需要「approve_purchases」權限";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          已選 <span className="font-medium tabular-nums">{selectedCount}</span> / {totalOnPage} 筆
        </span>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={onSelectAll}>
          全選本頁
        </Button>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={onClear}>
          清除選取
        </Button>
        {selectedCount > 0 && pendingCount === 0 ? (
          <span className="text-xs text-muted-foreground">（選取的都不是待審核狀態）</span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10"
          disabled={busy || !canApprove || pendingCount === 0}
          title={blockedTitle}
          onClick={() => onBatchApprove(true)}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          批次通過{pendingCount > 0 ? `（${pendingCount}）` : ""}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
          disabled={busy || !canApprove || pendingCount === 0}
          title={blockedTitle}
          onClick={() => onBatchApprove(false)}
        >
          <XCircle className="h-3.5 w-3.5" />
          批次退回
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={busy || selectedCount === 0}
          onClick={onOpenBatchUpdate}
        >
          <PencilRuler className="h-3.5 w-3.5" />
          批次更新供應商／效期
        </Button>
      </div>
    </div>
  );
}
