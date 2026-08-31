/**
 * 這一頁的兩個對話框 + 三個二次確認。
 *
 * 全部收在一起，理由與 ProductDialogs.tsx 相同：它們對 route 來說是同一件事
 * 「某個 state 不是 null 的時候蓋一層東西上去」。留在 route 檔只會把真正的版面
 * （統計卡、篩選、表格、分頁）推到 300 行以外。
 *
 * ⚠️ 刪除草稿、退回、沖帳三個是**破壞性動作**，所以都要按兩次。送出與審核通過不問：
 *    那是這一頁最常做的兩件事，每次都跳一個對話框只會訓練出「看到就按確定」。
 */
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
import { AdjustmentDetailDialog } from "@/components/inventory/AdjustmentDetailDialog";
import { AdjustmentFormDialog } from "@/components/inventory/AdjustmentFormDialog";
import type { AdminAdjustmentRow } from "@/server/repos/inv-adjustments";

export type ConfirmKind = "delete" | "reject" | "reverse";
export type PendingConfirm = { kind: ConfirmKind; row: AdminAdjustmentRow } | null;

type Props = {
  approvalOn: boolean;
  canApprove: boolean;
  busyId: string | null;
  refresh: () => Promise<void>;

  formOpen: boolean;
  setFormOpen: (v: boolean) => void;

  detail: AdminAdjustmentRow | null;
  setDetail: (v: AdminAdjustmentRow | null) => void;

  confirming: PendingConfirm;
  setConfirming: (v: PendingConfirm) => void;

  onSubmit: (row: AdminAdjustmentRow) => void;
  onApprove: (row: AdminAdjustmentRow) => void;
  onResubmit: (row: AdminAdjustmentRow) => void;
  /** 二次確認按下去之後真的執行的那一支。 */
  onConfirmed: (kind: ConfirmKind, row: AdminAdjustmentRow) => void;
};

function confirmCopy(kind: ConfirmKind, row: AdminAdjustmentRow) {
  const no = row.adjustment_number ?? "這張單";
  if (kind === "delete") {
    return {
      title: `刪除草稿 ${no}？`,
      body: "這個動作無法復原。只有草稿刪得掉 —— 已確認的單據會被資料庫擋下來，那種情況請改用沖帳，帳才留得下軌跡。",
      action: "確認刪除",
    };
  }
  if (kind === "reject") {
    return {
      title: `退回 ${no}？`,
      body: "退回之後這張單不會生效，庫存維持原樣。建立的人可以改完再送一次審。",
      action: "確認退回",
    };
  }
  return {
    title: `沖帳 ${no}？`,
    body: `將建立一筆數量 ${-row.quantity > 0 ? "+" : ""}${-row.quantity} 的反向異動單，庫存會相應回復。原單保留不動，而且沖帳單本身不能再被沖。`,
    action: "確認沖帳",
  };
}

export function AdjustmentDialogs(props: Props) {
  const {
    approvalOn,
    canApprove,
    busyId,
    refresh,
    formOpen,
    setFormOpen,
    detail,
    setDetail,
    confirming,
    setConfirming,
    onSubmit,
    onApprove,
    onResubmit,
    onConfirmed,
  } = props;

  const copy = confirming ? confirmCopy(confirming.kind, confirming.row) : null;

  return (
    <>
      <AdjustmentFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        approvalOn={approvalOn}
        onSaved={refresh}
      />

      <AdjustmentDetailDialog
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        row={detail}
        canApprove={canApprove}
        busy={detail !== null && busyId === detail.adjustment_id}
        onSubmit={onSubmit}
        onApprove={onApprove}
        onResubmit={onResubmit}
        onAskDelete={(row) => setConfirming({ kind: "delete", row })}
        onAskReject={(row) => setConfirming({ kind: "reject", row })}
        onAskReverse={(row) => setConfirming({ kind: "reverse", row })}
      />

      <AlertDialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">{copy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirming?.kind === "reverse"
                  ? undefined
                  : "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              }
              onClick={() => {
                const pending = confirming;
                setConfirming(null);
                if (pending) onConfirmed(pending.kind, pending.row);
              }}
            >
              {copy?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
