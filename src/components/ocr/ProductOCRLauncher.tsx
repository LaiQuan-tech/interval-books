/**
 * 商品頁上的「拍照辨識」按鈕 + 它的對話框。
 *
 * 與 PurchaseOCRLauncher 同一個做法：按鈕自己管開關，route 只放一行。
 * 沒有動 ProductPageHeader —— 那顆按鈕屬於 4c，把它塞進 4b 的元件裡會讓兩期的
 * 東西混在一個檔案裡，之後誰都不敢動。
 */
import { useState } from "react";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProductOCRDialog } from "@/components/ocr/ProductOCRDialog";
import type { AdminCategory, AdminVendor } from "@/server/repos/inv-products";

type Props = {
  categories: AdminCategory[];
  vendors: AdminVendor[];
  productApprovalOn: boolean;
  onSaved: () => void | Promise<void>;
  /** 辨識失敗時的退路：打開平常的「新增商品」表單。 */
  onManualEntry: () => void;
};

export function ProductOCRLauncher({
  categories,
  vendors,
  productApprovalOn,
  onSaved,
  onManualEntry,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Camera className="h-4 w-4" aria-hidden="true" />
        拍照辨識
      </Button>
      <p className="text-xs text-muted-foreground">
        拍一張書封，AI 讀出書名、期數、系列、出版社與條碼，確認之後才建檔。
      </p>
      <ProductOCRDialog
        open={open}
        onOpenChange={setOpen}
        categories={categories}
        vendors={vendors}
        productApprovalOn={productApprovalOn}
        onSaved={onSaved}
        onManualEntry={onManualEntry}
      />
    </div>
  );
}
