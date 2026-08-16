/**
 * 這一頁的兩個對話框 + 一個二次確認。
 *
 * 全部收在一起，理由與 AdjustmentDialogs.tsx 相同：它們對 route 來說是同一件事
 * 「某個 state 不是 null 的時候蓋一層東西上去」。留在 route 檔只會把真正的版面
 * （標題列、篩選、表格）推到 300 行以外。
 *
 * ⚠️ 只有刪除要按兩次。上下架按錯了再按一次就回來了；審核通過不問（那是這一頁最常
 *    做的事，每次都跳對話框只會訓練出「看到就按確定」），退回由 ApprovalActions
 *    自己問。
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
import { ComboSetDetailDialog } from "@/components/inventory/ComboSetDetailDialog";
import { ComboSetFormDialog } from "@/components/inventory/ComboSetFormDialog";
import type { AdminComboSetRow } from "@/server/repos/inv-combos";
import type { PosProduct } from "@/server/repos/inv-sales";

type Props = {
  approvalOn: boolean;
  products: PosProduct[];
  refresh: () => Promise<void>;

  formOpen: boolean;
  setFormOpen: (v: boolean) => void;
  /** null = 新增。 */
  editing: AdminComboSetRow | null;

  detail: AdminComboSetRow | null;
  setDetail: (v: AdminComboSetRow | null) => void;

  deleting: AdminComboSetRow | null;
  setDeleting: (v: AdminComboSetRow | null) => void;
  onConfirmDelete: (row: AdminComboSetRow) => void;
};

export function ComboSetDialogs({
  approvalOn,
  products,
  refresh,
  formOpen,
  setFormOpen,
  editing,
  detail,
  setDetail,
  deleting,
  setDeleting,
  onConfirmDelete,
}: Props) {
  return (
    <>
      <ComboSetFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        approvalOn={approvalOn}
        editing={editing}
        products={products}
        onSaved={refresh}
      />

      <ComboSetDetailDialog
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        row={detail}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              刪除套餐「{deleting?.name}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              這個動作無法復原。已經賣出過的套餐刪不掉 —— 資料庫會擋下來並告訴你賣了幾份，
              那種情況請改成下架，銷售紀錄才留得住。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const pending = deleting;
                setDeleting(null);
                if (pending) onConfirmDelete(pending);
              }}
            >
              確認刪除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
