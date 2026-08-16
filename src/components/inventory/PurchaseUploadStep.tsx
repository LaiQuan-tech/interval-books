/**
 * 進貨 Excel 匯入的第一步：選檔案，或先下載一份範本。
 *
 * ⚠️ 範本是用 **dynamic import** 的 xlsx 產的。xlsx 有 Node 專屬分支，靜態 import
 *    會在 SSR 端炸掉整頁 —— 與讀檔那一邊同一條規矩。
 *
 * 範本的標題列與 purchase-import.ts 的自動對應候選字是對得上的：照這份範本填，
 * 十三個欄位會全部自動對好，第二步只要按「下一步」。
 */
import { useRef } from "react";
import { Download, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";

/** 用 \t 分欄，只是為了不要讓一份 13 欄 × 3 列的表格佔掉四十行。 */
const TEMPLATE = [
  "商品名稱\t期數\t系列\t條碼\t商品類型\t分類\t數量\t單價成本\t供應商\t進貨日期\t保存期限\t效期警示天數\t備註",
  "範例商品A\t15\t地味手帖\t9789861234567\t買斷\t雜誌\t5\t200\t大和書報\t{today}\t\t7\t",
  "範例商品B\t\t\t\t寄賣\t\t10\t150\t\t{today}\t\t\t整箱進貨",
];

type Props = {
  busy: boolean;
  onFile: (files: FileList | null) => Promise<void>;
};

export function PurchaseUploadStep({ busy, onFile }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  async function downloadTemplate() {
    try {
      const XLSX = await import("xlsx");
      const today = todayInTaipei();
      const aoa = TEMPLATE.map((line) => line.replaceAll("{today}", today).split("\t"));
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), "進貨匯入範本");
      XLSX.writeFile(book, "進貨匯入範本.xlsx");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "範本下載失敗");
    }
  }

  return (
    <div className="space-y-3">
      <input
        ref={fileRef}
        type="file"
        accept=".xls,.xlsx"
        className="hidden"
        onChange={(e) =>
          void onFile(e.target.files).finally(() => {
            if (fileRef.current) fileRef.current.value = "";
          })
        }
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="flex w-full flex-col items-center gap-2 rounded-md border border-dashed border-border p-10 transition-colors hover:border-primary"
      >
        {busy ? (
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        ) : (
          <Upload className="h-7 w-7 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">點這裡選擇檔案</span>
        <span className="text-xs text-muted-foreground">支援 .xls 與 .xlsx，一次最多 2000 列</span>
      </button>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={downloadTemplate}>
        <Download className="h-3.5 w-3.5" />
        下載匯入範本
      </Button>
    </div>
  );
}
