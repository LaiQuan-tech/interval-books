/**
 * 進貨頁的標題列與那排動作按鈕。
 *
 * 與商品頁的 ProductPageHeader 對稱 —— 那一頁 4b 就拆出來了，這一頁當時還放得下
 * 所以留在 route 裡。4c 把拍照辨識掛上去之後就超過 300 行了，補上這個對稱缺口。
 *
 * ⚠️ 這裡只有畫面。`selectMode`、匯入、辨識、新增全部由 route 傳進來的 callback
 *    決定，這個元件不知道也不該知道任何一支 server fn。
 */
import { FileSpreadsheet, Plus, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PurchaseOCRLauncher } from "@/components/ocr/PurchaseOCRLauncher";
import type { VendorOption } from "@/components/inventory/VendorSelect";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

type Props = {
  total: number;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  onOpenImport: () => void;
  onCreate: () => void;
  /** 拍照辨識要用的清單與設定 —— 見 components/ocr/PurchaseOCRLauncher。 */
  products: ProductPickerRow[];
  vendors: VendorOption[];
  categories: { category_id: string; name: string }[];
  approvalOn: boolean;
  onImported: () => void | Promise<void>;
};

export function PurchasePageHeader({
  total,
  selectMode,
  onToggleSelectMode,
  onOpenImport,
  onCreate,
  products,
  vendors,
  categories,
  approvalOn,
  onImported,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Truck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-lg font-medium">進貨</h1>
        <span className="text-sm text-muted-foreground">共 {total} 筆</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onToggleSelectMode}>
          {selectMode ? "取消批次操作" : "批次操作"}
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenImport}>
          <FileSpreadsheet className="h-3.5 w-3.5" />
          匯入 Excel
        </Button>
        <PurchaseOCRLauncher
          products={products}
          vendors={vendors}
          categories={categories}
          approvalOn={approvalOn}
          onImported={onImported}
          // 辨識失敗時的退路：關掉辨識、打開平常的新增進貨表單。
          onManualEntry={onCreate}
        />
        <Button size="sm" className="gap-1.5" onClick={onCreate}>
          <Plus className="h-3.5 w-3.5" />
          新增進貨
        </Button>
      </div>
    </div>
  );
}
