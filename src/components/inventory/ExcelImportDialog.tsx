/**
 * Excel 匯入精靈：上傳 → 對應欄位 → 預覽 → 寫入。
 *
 * ⚠️ xlsx 走 **dynamic import**。它有 Node 專屬分支，靜態 import 會在 SSR 端炸掉
 *    整頁（與 html5-qrcode 同一條規矩，pos-counter-selftest 有一條在守）。
 *
 * ⚠️ 解析在瀏覽器，**寫入只有 importProducts() 這一條路**。瀏覽器沒有任何一個
 *    地方碰得到資料庫 —— 這不只是慣例，是結構：service_role 只存在伺服器，
 *    inv 也不在 PostgREST 上。整批一個交易，不會出現「匯了一半」。
 */
import { useRef, useState } from "react";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
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
import { ExcelMappingStep } from "@/components/inventory/ExcelMappingStep";
import {
  ExcelPreviewStep,
  type ImportOptions,
} from "@/components/inventory/ExcelPreviewStep";
import {
  autoMapColumns,
  EMPTY_MAPPING,
  parseRows,
  UNMAPPED,
  type ColumnMapping,
  type ParsedRow,
  type SkippedRow,
} from "@/lib/admin/excel-import";
import { loadAllProductsForMatching, todayInTaipei } from "@/lib/admin/inv-product-utils";
import type { AdminCategory } from "@/server/repos/inv-products";

type Step = "upload" | "mapping" | "preview";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: AdminCategory[];
  productApprovalOn: boolean;
  onImported: () => void | Promise<void>;
};

export function ExcelImportDialog({
  open,
  onOpenChange,
  categories,
  productApprovalOn,
  onImported,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [skipped, setSkipped] = useState<SkippedRow[]>([]);
  const [merged, setMerged] = useState(0);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<ImportOptions>({
    create_purchase_record: true,
    category_id: "",
    product_type: "outright",
    vendor: "",
    purchase_date: todayInTaipei(),
  });

  function reset() {
    setStep("upload");
    setHeaders([]);
    setRawRows([]);
    setMapping(EMPTY_MAPPING);
    setRows([]);
    setSkipped([]);
    setMerged(0);
    setOptions({
      create_purchase_record: true,
      category_id: "",
      product_type: "outright",
      vendor: "",
      purchase_date: todayInTaipei(),
    });
    if (fileRef.current) fileRef.current.value = "";
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

      // header:1 → 二維陣列；raw:false → 全部轉字串（避免日期／數字被 Excel 的
      // 格式吃掉，例如 ISBN 被讀成科學記號）。
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][];
      if (grid.length < 2) throw new Error("檔案至少要有標題列與一列資料");

      const head = (grid[0] ?? []).map((h) => String(h ?? "").trim());
      setHeaders(head);
      setRawRows(grid.slice(1));
      setMapping(autoMapColumns(head));
      setStep("mapping");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "檔案讀取失敗，請確認格式是 .xls 或 .xlsx");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function applyMapping() {
    if (mapping.name === UNMAPPED) {
      toast.error("請先指定「商品名稱」對應到哪一欄");
      return;
    }
    setBusy(true);
    try {
      // 比對既有商品要先問伺服器有哪些商品（整份，翻頁拿完 —— 見那支函式的註解）。
      const all = await loadAllProductsForMatching();

      const result = parseRows(rawRows, mapping, all);
      if (result.rows.length === 0) {
        toast.error("沒有解析到任何一列 —— 請確認欄位對應");
        return;
      }
      setRows(result.rows);
      setSkipped(result.skipped);
      setMerged(result.mergedCount);
      setStep("preview");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "解析失敗");
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    const chosen = rows.filter((r) => r.selected);
    if (chosen.length === 0) {
      toast.error("請至少選一列");
      return;
    }
    setBusy(true);
    try {
      const { importProducts } = await import("@/lib/admin/fns/inv-products");
      const result = await importProducts({
        data: {
          rows: chosen.map((r) => ({
            name: r.name,
            issue_number: r.issue_number,
            barcode: r.barcode,
            series: r.series,
            publisher: r.publisher,
            notes: r.notes,
            selling_price: r.selling_price,
            cost_price: r.cost_price,
            quantity: r.quantity,
            existing_product_id: r.existing_product_id,
          })),
          options: {
            create_purchase_record: options.create_purchase_record,
            category_id: options.category_id || null,
            product_type: options.product_type,
            vendor: options.vendor.trim() || null,
            purchase_date: options.purchase_date,
          },
        },
      });
      toast.success(
        `匯入完成：新增 ${result.created} 件、更新 ${result.updated} 件` +
          (result.purchases > 0 ? `、建立 ${result.purchases} 筆進貨` : ""),
      );
      reset();
      onOpenChange(false);
      await onImported();
    } catch (err) {
      // 整批一個交易：失敗就是一列都沒寫進去。這句話要講清楚，否則店員會怕
      // 「是不是匯了一半」而重跑一次。
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
            Excel 匯入商品
          </DialogTitle>
          <DialogDescription>
            {step === "upload" ? "選一個 .xls 或 .xlsx 檔案，只會讀第一個工作表。" : null}
            {step === "mapping" ? "確認每一個欄位對應到 Excel 的哪一欄。商品名稱是必要的。" : null}
            {step === "preview"
              ? "確認要匯入哪幾列。整批是一個交易 —— 失敗的話一列都不會寫進去。"
              : null}
          </DialogDescription>
        </DialogHeader>

        {step === "upload" ? (
          <div className="space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept=".xls,.xlsx"
              className="hidden"
              onChange={(e) => void handleFile(e.target.files)}
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
          </div>
        ) : null}

        {step === "mapping" ? (
          <ExcelMappingStep
            headers={headers}
            rawRows={rawRows}
            mapping={mapping}
            onMappingChange={setMapping}
          />
        ) : null}

        {step === "preview" ? (
          <ExcelPreviewStep
            rows={rows}
            onRowsChange={setRows}
            skipped={skipped}
            merged={merged}
            options={options}
            onOptionsChange={setOptions}
            categories={categories}
            productApprovalOn={productApprovalOn}
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
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
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
