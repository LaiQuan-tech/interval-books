/**
 * 進貨頁工具列上的「拍照辨識」按鈕 + 它的對話框。
 *
 * 按鈕與對話框綁在同一個元件裡，是因為 route 只在乎「有這個入口」，不在乎它自己
 * 的開關狀態。route 檔已經在 300 行的線上，多一顆按鈕就要多一個 useState、一個
 * import、一段 JSX —— 那三樣東西沒有一樣是那個檔案該關心的。
 */
import { useState } from "react";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PurchaseOCRDialog } from "@/components/ocr/PurchaseOCRDialog";
import type { VendorOption } from "@/components/inventory/VendorSelect";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

type Props = {
  products: ProductPickerRow[];
  vendors: VendorOption[];
  categories: { category_id: string; name: string }[];
  approvalOn: boolean;
  onImported: () => void | Promise<void>;
  /** 辨識失敗時的退路：打開平常的「新增進貨」表單。 */
  onManualEntry: () => void;
};

export function PurchaseOCRLauncher({
  products,
  vendors,
  categories,
  approvalOn,
  onImported,
  onManualEntry,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Camera className="h-3.5 w-3.5" aria-hidden="true" />
        拍照辨識
      </Button>
      <PurchaseOCRDialog
        open={open}
        onOpenChange={setOpen}
        products={products}
        vendors={vendors}
        categories={categories}
        approvalOn={approvalOn}
        onImported={onImported}
        onManualEntry={onManualEntry}
      />
    </>
  );
}
