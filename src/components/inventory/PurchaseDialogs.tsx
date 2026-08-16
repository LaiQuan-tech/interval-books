/**
 * 這一頁的三個對話框 + 刪除確認。
 *
 * 全部收在一起，是因為它們對 route 來說是同一件事：「某個 state 不是 null 的時候
 * 蓋一層東西上去」。route 檔留著它們只會讓真正的版面（統計卡、篩選、表格、分頁）
 * 被推到 300 行以外。與 ProductDialogs.tsx 同一個做法。
 *
 * ⚠️ 刪除的說明文字是**修好之後**的行為：0017 的
 *    rollback_stock_on_purchase_delete() 會把沒出庫過的批次連庫存一起收回，出過
 *    貨的則整個擋下來。來源那句「庫存不會自動調整」現在是錯的，照抄會讓店員刪完
 *    再去手動改一次庫存，變成扣兩次。
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
import { PurchaseBatchUpdateDialog } from "@/components/inventory/PurchaseBatchUpdateDialog";
import { PurchaseFormDialog } from "@/components/inventory/PurchaseFormDialog";
import { PurchaseImportDialog } from "@/components/inventory/PurchaseImportDialog";
import type { VendorOption } from "@/components/inventory/VendorSelect";
import type { AdminPurchaseRow, ProductPickerRow } from "@/server/repos/inv-purchases";

type Props = {
  products: ProductPickerRow[];
  vendors: VendorOption[];
  categories: { category_id: string; name: string }[];
  approvalOn: boolean;
  refresh: () => Promise<void>;

  formOpen: boolean;
  setFormOpen: (v: boolean) => void;
  editing: AdminPurchaseRow | null;

  deleting: AdminPurchaseRow | null;
  setDeleting: (v: AdminPurchaseRow | null) => void;
  onConfirmDelete: (row: AdminPurchaseRow) => void;

  importOpen: boolean;
  setImportOpen: (v: boolean) => void;

  batchUpdateOpen: boolean;
  setBatchUpdateOpen: (v: boolean) => void;
  selectedIds: string[];
  onBatchUpdated: () => Promise<void>;
};

export function PurchaseDialogs(props: Props) {
  const {
    products,
    vendors,
    categories,
    approvalOn,
    refresh,
    formOpen,
    setFormOpen,
    editing,
    deleting,
    setDeleting,
    onConfirmDelete,
    importOpen,
    setImportOpen,
    batchUpdateOpen,
    setBatchUpdateOpen,
    selectedIds,
    onBatchUpdated,
  } = props;

  const deletingName = deleting?.item_name || deleting?.product_name || "這一批";

  return (
    <>
      <PurchaseFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        purchase={editing}
        products={products}
        vendors={vendors}
        approvalOn={approvalOn}
        onSaved={refresh}
      />

      <PurchaseImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        products={products}
        vendors={vendors}
        categories={categories}
        approvalOn={approvalOn}
        onImported={refresh}
      />

      <PurchaseBatchUpdateDialog
        open={batchUpdateOpen}
        onOpenChange={setBatchUpdateOpen}
        selectedIds={selectedIds}
        vendors={vendors}
        onDone={onBatchUpdated}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              刪除「{deletingName}」這一批 {deleting?.quantity ?? 0} 件？
            </AlertDialogTitle>
            <AlertDialogDescription>
              沒有出庫過的批次刪掉之後，庫存會一起收回去（不用再自己手動調一次，否則會扣兩次）。
              已經賣掉的批次會被擋下來 —— 那種情況請改開一張在庫異動單，帳才留得住。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const row = deleting;
                setDeleting(null);
                if (row) onConfirmDelete(row);
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
