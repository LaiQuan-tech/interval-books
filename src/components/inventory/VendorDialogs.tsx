/**
 * 廠商這一頁的兩個對話框 + 一個二次確認。
 *
 * 全部收在一起，理由與 ComboSetDialogs.tsx / AdjustmentDialogs.tsx 相同：它們對
 * route 來說是同一件事「某個 state 不是 null 的時候蓋一層東西上去」。留在 route 檔
 * 只會把真正的版面（標題列、送審佇列、篩選、表格）推到 300 行以外。
 *
 * ⚠️ **刪除的對話框要把話講完。** inv_delete_vendor() 會在還有商品／進貨／退貨單／
 *    入口帳號的時候擋下來，並回一句「解約請把往來狀態改成『已終止』」。這裡把同一件
 *    事先講在前面，而且把那四個數字印出來 —— 「按了才知道不行」是最差的順序，尤其
 *    當正確做法（改往來狀態）根本不在同一個按鈕底下的時候。
 *
 * ⚠️ 詳情是唯讀的，而且**識別碼與匯款帳號永遠是遮罩**（見 VendorDetailDialog）。
 *    完整號碼只有 VendorSensitiveDialog 那一條路，而那一條路會留下 pii_access_log。
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
import { VendorDetailDialog } from "@/components/inventory/VendorDetailDialog";
import { VendorFormDialog } from "@/components/inventory/VendorFormDialog";
import type {
  AdminVendorRow,
  TaxTypeRow,
  VendorCategoryRow,
  WithholdingRow,
} from "@/server/repos/inv-vendors";

type Props = {
  approvalOn: boolean;
  categories: VendorCategoryRow[];
  taxTypes: TaxTypeRow[];
  withholdingCategories: WithholdingRow[];
  refresh: () => Promise<void>;

  formOpen: boolean;
  setFormOpen: (v: boolean) => void;
  /** null = 新增。 */
  editing: AdminVendorRow | null;

  detail: AdminVendorRow | null;
  setDetail: (v: AdminVendorRow | null) => void;

  deleting: AdminVendorRow | null;
  setDeleting: (v: AdminVendorRow | null) => void;
  onConfirmDelete: (row: AdminVendorRow) => void;
};

export function VendorDialogs({
  approvalOn,
  categories,
  taxTypes,
  withholdingCategories,
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
  const linkedCount =
    (deleting?.product_count ?? 0) +
    (deleting?.purchase_count ?? 0) +
    (deleting?.portal_account_count ?? 0);

  return (
    <>
      <VendorFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        approvalOn={approvalOn}
        editing={editing}
        categories={categories}
        taxTypes={taxTypes}
        withholdingCategories={withholdingCategories}
        onSaved={refresh}
      />

      <VendorDetailDialog
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        row={detail}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              刪除廠商「{deleting?.name}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              這個動作無法復原。
              {linkedCount > 0 ? (
                <>
                  <strong>
                    這家還有 {deleting?.product_count ?? 0} 件商品、
                    {deleting?.purchase_count ?? 0} 筆進貨、
                    {deleting?.portal_account_count ?? 0} 個自助入口帳號
                  </strong>
                  ，資料庫會擋下來 —— 帳與貨的歷史要留著，不能因為刪一筆主檔就變成孤兒。
                  不再往來請改成「編輯 → 往來狀態 → 已終止」，那才是解約的做法。
                </>
              ) : (
                "只有完全沒有往來資料（商品、進貨、退貨單、自助入口帳號）的廠商刪得掉。有任何一種，資料庫都會擋下來並告訴你各有幾筆 —— 那種情況請把往來狀態改成「已終止」。"
              )}
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
