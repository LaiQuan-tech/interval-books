/**
 * 進貨單拍照辨識：拍照 → Gemini → **可以逐列修改的確認表** → 走既有的 importPurchases()。
 *
 * ── AI 沒有寫入權 ─────────────────────────────────────────────────────────
 * 這個對話框不會寫任何一張表。辨識回來的是一份建議，寫入只有最後那一次
 * importPurchases()（整批一個交易，與 Excel 匯入同一條路）。模型讀錯一個單價就是
 * 錯誤的庫存成本 —— 中間一定要隔一個人。
 *
 * ── 只送 key，不送圖 ──────────────────────────────────────────────────────
 * uploadOcrImage() 壓縮完上傳，拿到 "ocr:…"，之後 recognisePurchaseOrder 只送這個
 * 字串。沒有任何 base64／data URL 會流向 server fn（見 lib/admin/ocr-scan.ts）。
 *
 * ── 失敗一定留一條路 ──────────────────────────────────────────────────────
 * 五種 kind 與「直接 throw 的例外」全部落在 OcrFailureNotice 上，那裡永遠有一顆
 * 「改用手動輸入」會關掉這裡、打開平常的新增進貨表單。
 */
import { useState } from "react";
import { Camera, Loader2 } from "lucide-react";
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
import { OcrCaptureStep } from "@/components/ocr/OcrCaptureStep";
import { OcrFailureNotice } from "@/components/ocr/OcrFailureNotice";
import { PurchaseOCRItems, type OcrPurchaseRow } from "@/components/ocr/PurchaseOCRItems";
import { PurchaseOCROptions, type OcrPurchaseOptions } from "@/components/ocr/PurchaseOCROptions";
import { toOcrFailure, uploadOcrImage, type OcrFailure } from "@/lib/admin/ocr-scan";
import {
  emptyPurchaseOptions,
  toPurchaseOptions,
  toPurchaseRows,
} from "@/lib/admin/ocr-purchase-map";
import type { VendorOption } from "@/components/inventory/VendorSelect";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: ProductPickerRow[];
  vendors: VendorOption[];
  categories: { category_id: string; name: string }[];
  approvalOn: boolean;
  onImported: () => void | Promise<void>;
  /** 關掉這裡並打開平常的「新增進貨」表單。失敗時的退路。 */
  onManualEntry: () => void;
};

export function PurchaseOCRDialog(props: Props) {
  const {
    open,
    onOpenChange,
    products,
    vendors,
    categories,
    approvalOn,
    onImported,
    onManualEntry,
  } = props;

  const [step, setStep] = useState<"capture" | "confirm">("capture");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("上傳中…");
  const [failure, setFailure] = useState<OcrFailure | null>(null);
  const [scanKey, setScanKey] = useState<string | null>(null);
  const [rows, setRows] = useState<OcrPurchaseRow[]>([]);
  const [options, setOptions] = useState<OcrPurchaseOptions>(emptyPurchaseOptions);

  function reset() {
    setStep("capture");
    setBusy(false);
    setFailure(null);
    setScanKey(null);
    setRows([]);
    setOptions(emptyPurchaseOptions());
  }

  /** 辨識。逾時之後的「再辨識一次」也走這裡 —— 圖已經在 storage 了，不用重傳。 */
  async function recognise(key: string) {
    setBusyLabel("辨識中…");
    setBusy(true);
    setFailure(null);
    try {
      const { recognisePurchaseOrder } = await import("@/lib/admin/fns/ocr");
      const result = await recognisePurchaseOrder({ data: { scan_key: key } });
      // ⚠️ 辨識失敗**不會 throw**，是一個 ok:false（見 fns/ocr.ts 的檔頭）。
      if (!result.ok) {
        setFailure({ kind: result.kind, message: result.message });
        return;
      }

      // 配對與廠商判斷都在 lib/admin/ocr-purchase-map.ts —— 那是這條流程裡唯一
      // 有判斷的純函式，抽出去才驗得動。
      const data = result.data;
      setRows(toPurchaseRows(products, data.items));
      setOptions(toPurchaseOptions(vendors, data));
      setStep("confirm");
    } catch (err) {
      setFailure(toOcrFailure(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleImage(source: File | Blob) {
    setBusyLabel("上傳中…");
    setBusy(true);
    setFailure(null);
    try {
      const key = await uploadOcrImage(source);
      setScanKey(key);
      await recognise(key);
    } catch (err) {
      setFailure(toOcrFailure(err));
      setBusy(false);
    }
  }

  function goManual() {
    reset();
    onOpenChange(false);
    onManualEntry();
  }

  async function runImport() {
    const chosen = rows.filter((r) => r.selected);
    if (chosen.length === 0) {
      toast.error("請至少選一列");
      return;
    }
    const bad = chosen.find(
      (r) => !r.name.trim() || !Number.isInteger(Number(r.quantity)) || Number(r.quantity) < 1,
    );
    if (bad) {
      toast.error(`「${bad.name || "未命名"}」的名稱或數量不正確 —— 數量要是大於 0 的整數`);
      return;
    }

    setBusy(true);
    try {
      const { importPurchases } = await import("@/lib/admin/fns/inv-purchases");
      const cost = (v: string) => (v.trim() === "" ? null : Number(v));
      const result = await importPurchases({
        data: {
          rows: chosen.map((r) => ({
            product_id: r.product_id,
            name: r.name.trim(),
            issue_number: r.issue_number.trim() || null,
            series: r.series.trim() || null,
            barcode: null,
            quantity: Number(r.quantity),
            unit_cost: cost(r.unit_cost),
            vendor_id: options.vendor_id || null,
            vendor: options.vendor_id ? null : options.vendor.trim() || null,
            purchase_date: options.purchase_date || null,
            notes: options.notes.trim() || null,
            expiry_date: null,
            expiry_alert_days: null,
            product_type: null,
            category_id: options.category_id || null,
          })),
          options: {
            default_vendor_id: options.vendor_id || null,
            default_category_id: options.category_id || null,
            default_purchase_date: options.purchase_date || null,
            default_expiry_alert_days: null,
          },
        },
      });
      toast.success(
        `辨識匯入完成：建立 ${result.purchases_created} 筆進貨` +
          (result.products_created > 0 ? `、新增 ${result.products_created} 件商品` : "") +
          (result.needs_approval ? "，全部進入待審核" : "，庫存已更新"),
      );
      reset();
      onOpenChange(false);
      await onImported();
    } catch (err) {
      // 整批一個交易：失敗就是一列都沒寫進去。這句話要講清楚，否則店員會重跑一次。
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
            <Camera className="h-4 w-4" aria-hidden="true" />
            拍照辨識進貨單
          </DialogTitle>
          <DialogDescription>
            {step === "capture"
              ? "拍一張進貨單，AI 讀出廠商、日期與逐項的商品、數量、單價。"
              : "逐列確認 —— 數量與單價一定要親眼看過。整批是一個交易，失敗的話一列都不會寫進去。"}
          </DialogDescription>
        </DialogHeader>

        {failure ? (
          <OcrFailureNotice
            failure={failure}
            onRetry={() => {
              if (scanKey) void recognise(scanKey);
              else setFailure(null);
            }}
            onRecapture={() => {
              setFailure(null);
              setScanKey(null);
              setStep("capture");
            }}
            onManual={goManual}
          />
        ) : step === "capture" ? (
          <OcrCaptureStep
            busy={busy}
            busyLabel={busyLabel}
            hint="整張單據拍滿、字要看得清楚"
            onImage={handleImage}
          />
        ) : (
          <div className="space-y-4">
            <PurchaseOCROptions
              options={options}
              onOptionsChange={setOptions}
              vendors={vendors}
              categories={categories}
            />
            <PurchaseOCRItems rows={rows} onRowsChange={setRows} products={products} />
            <p className="text-xs text-muted-foreground">
              已選 {selectedCount} / {rows.length} 列，其中{" "}
              {rows.filter((r) => r.selected && !r.product_id).length} 列會建立新商品。
              {approvalOn ? "匯入的進貨會進入待審核。" : "審核已關閉，匯入的進貨會直接生效。"}
            </p>
          </div>
        )}

        <DialogFooter>
          {step === "confirm" && !failure ? (
            <Button variant="ghost" disabled={busy} onClick={() => setStep("capture")}>
              重新拍照
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {step === "confirm" && !failure ? (
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
