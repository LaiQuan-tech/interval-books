/**
 * 進貨 Excel 匯入精靈：上傳 → 對應欄位 → 預覽 → 寫入。
 *
 * ⚠️ xlsx 走 **dynamic import**（兩個地方：讀檔與下載範本）。它有 Node 專屬分支，
 *    靜態 import 會在 SSR 端炸掉整頁 —— 與 html5-qrcode 同一條規矩。
 *
 * ⚠️ 解析在瀏覽器，**寫入只有 importPurchases() 這一條路**。瀏覽器沒有任何一個
 *    地方碰得到資料庫（service_role 只存在伺服器，inv 也不在 PostgREST 上），而且
 *    整批是一個交易 —— 不會出現「匯了一半，商品建好了但進貨沒進去」。
 */
import { useState } from "react";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PurchaseMappingStep } from "@/components/inventory/PurchaseMappingStep";
import {
  PurchasePreviewStep,
  type PurchaseImportOptions,
} from "@/components/inventory/PurchasePreviewStep";
import { PurchaseUploadStep } from "@/components/inventory/PurchaseUploadStep";
import type { VendorOption } from "@/components/inventory/VendorSelect";
import { UNMAPPED } from "@/lib/admin/excel-import";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import {
  autoMapPurchaseColumns,
  EMPTY_PURCHASE_MAPPING,
  parsePurchaseRows,
  type ParsedPurchaseRow,
  type PurchaseColumnMapping,
  type SkippedPurchaseRow,
} from "@/lib/admin/purchase-import";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

type Step = "upload" | "mapping" | "preview";

/** 四個預設值。進貨日期預設今天（台北），其餘留空 = 不指定。 */
function emptyOptions(): PurchaseImportOptions {
  return {
    default_vendor_id: "",
    default_category_id: "",
    default_purchase_date: todayInTaipei(),
    default_expiry_alert_days: "",
  };
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: ProductPickerRow[];
  vendors: VendorOption[];
  categories: { category_id: string; name: string }[];
  approvalOn: boolean;
  onImported: () => void | Promise<void>;
};

export function PurchaseImportDialog({
  open,
  onOpenChange,
  products,
  vendors,
  categories,
  approvalOn,
  onImported,
}: Props) {
  const [step, setStep] = useState<Step>("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<PurchaseColumnMapping>(EMPTY_PURCHASE_MAPPING);
  const [rows, setRows] = useState<ParsedPurchaseRow[]>([]);
  const [skipped, setSkipped] = useState<SkippedPurchaseRow[]>([]);
  const [merged, setMerged] = useState(0);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<PurchaseImportOptions>(emptyOptions);

  function reset() {
    setStep("upload");
    setHeaders([]);
    setRawRows([]);
    setMapping(EMPTY_PURCHASE_MAPPING);
    setRows([]);
    setSkipped([]);
    setMerged(0);
    setOptions(emptyOptions());
  }

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      // ← 這一行就是那個「不能改成靜態 import」的地方。
      const XLSX = await import("xlsx");
      const buffer = await file.arrayBuffer();
      // codepage 950 = Big5。這家店的舊進貨單很多是這個編碼，不指定會變成亂碼。
      const workbook = XLSX.read(buffer, { type: "array", codepage: 950 });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("這個檔案裡沒有工作表");

      // header:1 → 二維陣列；raw:false → 全部轉字串（否則 ISBN 會變成科學記號）。
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][];
      if (grid.length < 2) throw new Error("檔案至少要有標題列與一列資料");

      const head = (grid[0] ?? []).map((h) => String(h ?? "").trim());
      setHeaders(head);
      setRawRows(grid.slice(1));
      setMapping(autoMapPurchaseColumns(head));
      setStep("mapping");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "檔案讀取失敗，請確認格式是 .xls 或 .xlsx");
    } finally {
      // input 的值由 PurchaseUploadStep 自己清（同一個檔案選第二次也要有反應）。
      setBusy(false);
    }
  }

  function applyMapping() {
    if (mapping.name === UNMAPPED) {
      toast.error("請先指定「商品名稱」對應到哪一欄");
      return;
    }
    if (mapping.quantity === UNMAPPED) {
      toast.error("請先指定「數量」對應到哪一欄");
      return;
    }
    const result = parsePurchaseRows(rawRows, mapping, { products, vendors, categories });
    if (result.rows.length === 0) {
      toast.error("沒有解析到任何一列 —— 請確認欄位對應");
      setSkipped(result.skipped);
      return;
    }
    setRows(result.rows);
    setSkipped(result.skipped);
    setMerged(result.mergedCount);
    setStep("preview");
  }

  async function runImport() {
    const chosen = rows.filter((r) => r.selected);
    if (chosen.length === 0) {
      toast.error("請至少選一列");
      return;
    }
    setBusy(true);
    try {
      const { importPurchases } = await import("@/lib/admin/fns/inv-purchases");
      const result = await importPurchases({
        data: {
          rows: chosen.map(({ key, selected, matched_name, ...row }) => row),
          options: {
            default_vendor_id: options.default_vendor_id || null,
            default_category_id: options.default_category_id || null,
            default_purchase_date: options.default_purchase_date || null,
            default_expiry_alert_days: options.default_expiry_alert_days
              ? Number(options.default_expiry_alert_days)
              : null,
          },
        },
      });
      toast.success(
        `匯入完成：建立 ${result.purchases_created} 筆進貨` +
          (result.products_created > 0 ? `、新增 ${result.products_created} 件商品` : "") +
          (result.needs_approval ? "，全部進入待審核" : "，庫存已更新"),
      );
      reset();
      onOpenChange(false);
      await onImported();
    } catch (err) {
      // 整批一個交易：失敗就是一列都沒寫進去。這句話要講清楚，否則店員會怕
      // 「是不是匯了一半」而重跑一次，然後真的匯成兩份。
      toast.error(err instanceof Error ? err.message : "匯入失敗，沒有任何一列被寫入");
    } finally {
      setBusy(false);
    }
  }

  const selectedCount = rows.filter((r) => r.selected).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
            Excel 匯入進貨
          </DialogTitle>
          <DialogDescription>
            {step === "upload" ? "選一個 .xls 或 .xlsx 檔案，只會讀第一個工作表。" : null}
            {step === "mapping"
              ? "確認每一個欄位對應到 Excel 的哪一欄。商品名稱與數量是必要的。"
              : null}
            {step === "preview"
              ? "確認要匯入哪幾列。整批是一個交易 —— 失敗的話一列都不會寫進去。"
              : null}
          </DialogDescription>
        </DialogHeader>

        {step === "upload" ? <PurchaseUploadStep busy={busy} onFile={handleFile} /> : null}

        {step === "mapping" ? (
          <PurchaseMappingStep
            headers={headers}
            rawRows={rawRows}
            mapping={mapping}
            onMappingChange={setMapping}
          />
        ) : null}

        {step === "preview" ? (
          <PurchasePreviewStep
            rows={rows}
            onRowsChange={setRows}
            skipped={skipped}
            merged={merged}
            options={options}
            onOptionsChange={setOptions}
            categories={categories}
            vendors={vendors}
            approvalOn={approvalOn}
          />
        ) : null}

        <DialogFooter>
          {step !== "upload" ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setStep(step === "preview" ? "mapping" : "upload")}
            >
              上一步
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {step === "mapping" ? (
            <Button onClick={applyMapping} disabled={busy}>
              下一步
            </Button>
          ) : null}
          {step === "preview" ? (
            <Button onClick={runImport} disabled={busy || selectedCount === 0}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              匯入 {selectedCount} 列
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
