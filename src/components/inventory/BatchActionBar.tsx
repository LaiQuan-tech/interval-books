/**
 * 批次操作列。選取模式打開時出現。
 *
 * ⚠️ 批次審核只送**目前是 pending** 的那幾筆。來源的 BatchApprovalBar 不管原本
 *    狀態就整批覆寫，於是「全選 → 批次通過」會把已經退回的、已經通過的一起重寫
 *    一次 approved_by/approved_at —— 審核紀錄會顯示成「今天某某人核准的」，
 *    但實際上那件商品三個月前就過了。
 *
 * ⚠️ 這裡沒有「批次刪除」。來源也沒有，而且不該有：刪除在這個系統會留下孤兒
 *    銷售列（見 0016 的 inv_delete_product 註解），一次刪 200 件沒有辦法一件件
 *    看清楚擋下來的理由。
 */
import { useState } from "react";
import { CheckCircle2, Loader2, PencilRuler, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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

export function BatchActionBar({
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
  const [confirm, setConfirm] = useState<null | boolean>(null);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            已選 <span className="font-medium tabular-nums">{selectedCount}</span> / {totalOnPage}{" "}
            筆
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
            title={canApprove ? undefined : "需要「approve_products」權限"}
            onClick={() => setConfirm(true)}
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
            title={canApprove ? undefined : "需要「approve_products」權限"}
            onClick={() => setConfirm(false)}
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
            批次修改
          </Button>
        </div>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              {confirm ? "批次審核通過" : "批次退回"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              選取的 {selectedCount} 筆裡有 {pendingCount} 筆是待審核，只有那幾筆會被
              {confirm ? "通過" : "退回"}。已經審核過的不會被重寫。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const approved = confirm === true;
                setConfirm(null);
                onBatchApprove(approved);
              }}
            >
              確認
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
