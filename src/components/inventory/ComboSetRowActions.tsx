/**
 * 一列套餐的動作。
 *
 * ⚠️ 審核那兩顆走共用的 ApprovalActions，permissionName 帶 `approve_combo_sets`
 *    —— 沒有權限時按鈕是 disabled 而不是消失，讓人看得到「有這個動作，但我不能做」，
 *    而不是以為系統壞了。真正擋人的是 fns/inv-combos.ts#approveComboSet 那一次
 *    權限檢查（它重讀 context.staff.permissions，不信任前端）。
 *
 * ⚠️ 刪除是破壞性動作，所以往上丟給 ComboSetDialogs 的 AlertDialog 再問一次。
 *    已經賣過的套餐資料庫會直接擋掉，那句中文由 useComboActions 原樣 toast 出來。
 */
import { Eye, Loader2, Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApprovalActions } from "@/components/inventory/ApprovalActions";
import type { AdminComboSetRow } from "@/server/repos/inv-combos";

type Props = {
  row: AdminComboSetRow;
  busy: boolean;
  canApprove: boolean;
  onView: (row: AdminComboSetRow) => void;
  onEdit: (row: AdminComboSetRow) => void;
  onToggleActive: (row: AdminComboSetRow) => void;
  onAskDelete: (row: AdminComboSetRow) => void;
  onApprove: (row: AdminComboSetRow) => void;
  onReject: (row: AdminComboSetRow) => void;
  onResubmit: (row: AdminComboSetRow) => void;
};

export function ComboSetRowActions({
  row,
  busy,
  canApprove,
  onView,
  onEdit,
  onToggleActive,
  onAskDelete,
  onApprove,
  onReject,
  onResubmit,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <ApprovalActions
        status={row.approval_status}
        canApprove={canApprove}
        busy={busy}
        productName={row.name}
        permissionName="approve_combo_sets"
        onApprove={() => onApprove(row)}
        onReject={() => onReject(row)}
        onResubmit={() => onResubmit(row)}
      />

      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        title="查看詳細"
        disabled={busy}
        onClick={() => onView(row)}
      >
        <Eye className="h-4 w-4" />
        <span className="sr-only">查看詳細</span>
      </Button>

      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        title="編輯"
        disabled={busy}
        onClick={() => onEdit(row)}
      >
        <Pencil className="h-4 w-4" />
        <span className="sr-only">編輯</span>
      </Button>

      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        title={row.is_active ? "下架" : "上架"}
        disabled={busy}
        onClick={() => onToggleActive(row)}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : row.is_active ? (
          <PowerOff className="h-4 w-4" />
        ) : (
          <Power className="h-4 w-4" />
        )}
        <span className="sr-only">{row.is_active ? "下架" : "上架"}</span>
      </Button>

      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-destructive hover:text-destructive"
        title="刪除"
        disabled={busy}
        onClick={() => onAskDelete(row)}
      >
        <Trash2 className="h-4 w-4" />
        <span className="sr-only">刪除</span>
      </Button>
    </div>
  );
}
