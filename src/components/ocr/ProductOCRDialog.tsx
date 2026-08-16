/**
 * 書封拍照辨識：拍封面 → Gemini → **可以逐欄修改的確認表單** → 走既有的 saveProduct()。
 *
 * ── AI 沒有寫入權 ─────────────────────────────────────────────────────────
 * 辨識回來的是一份建議。寫入只有最後那一次 saveProduct()（同一支 server fn、同一
 * 個 invProductSchema、同一份 middleware），approval_status 仍然由資料庫算。
 *
 * ── 只送 key，不送圖 ──────────────────────────────────────────────────────
 * uploadOcrImage() 壓縮完上傳拿到 "ocr:…"，recogniseBook 只送這個字串。沒有任何
 * base64／data URL 會流向 server fn。
 *
 * ── confidence 誠實顯示 ───────────────────────────────────────────────────
 * 模型回的 high / medium / low 在畫面上長得不一樣（ProductOCRConfidence）。低信心
 * 的結果如果和高信心的長得一樣，那個訊號就等於沒有。
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
import { ProductOCRConfidence } from "@/components/ocr/ProductOCRConfidence";
import { ProductOCRFields, type OcrProductForm } from "@/components/ocr/ProductOCRFields";
import { invProductSchema } from "@/lib/admin/schemas";
import { toOcrFailure, uploadOcrImage, type OcrFailure } from "@/lib/admin/ocr-scan";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import type { AdminCategory, AdminVendor } from "@/server/repos/inv-products";
import type { OcrBookResult } from "@/server/gemini";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: AdminCategory[];
  vendors: AdminVendor[];
  productApprovalOn: boolean;
  onSaved: () => void | Promise<void>;
  /** 關掉這裡並打開平常的「新增商品」表單。失敗時的退路。 */
  onManualEntry: () => void;
};

const emptyForm = (): OcrProductForm => ({
  name: "",
  issue_number: "",
  series: "",
  publisher: "",
  barcode: "",
  category_id: "",
  vendor_id: "",
  product_type: "outright",
  selling_price: "",
  cost_price: "",
  with_purchase: true,
  quantity: "1",
  // ⚠️ todayInTaipei()，不是 new Date().toISOString().slice(0,10)（那是 UTC）。
  purchase_date: todayInTaipei(),
});

export function ProductOCRDialog(props: Props) {
  const { open, onOpenChange, categories, vendors, productApprovalOn, onSaved, onManualEntry } =
    props;

  const [step, setStep] = useState<"capture" | "confirm">("capture");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("上傳中…");
  const [failure, setFailure] = useState<OcrFailure | null>(null);
  const [scanKey, setScanKey] = useState<string | null>(null);
  const [form, setForm] = useState<OcrProductForm>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [book, setBook] = useState<Pick<OcrBookResult, "confidence" | "detected_text"> | null>(
    null,
  );

  function reset() {
    setStep("capture");
    setBusy(false);
    setFailure(null);
    setScanKey(null);
    setForm(emptyForm());
    setErrors({});
    setBook(null);
  }

  /** 辨識。逾時之後的「再辨識一次」也走這裡 —— 圖已經在 storage 了，不用重傳。 */
  async function recognise(key: string) {
    setBusyLabel("辨識中…");
    setBusy(true);
    setFailure(null);
    try {
      const { recogniseBook } = await import("@/lib/admin/fns/ocr");
      const result = await recogniseBook({ data: { scan_key: key } });
      // ⚠️ 辨識失敗**不會 throw**，是一個 ok:false（見 fns/ocr.ts 的檔頭）。
      if (!result.ok) {
        setFailure({ kind: result.kind, message: result.message });
        return;
      }

      const data = result.data;
      setForm({
        ...emptyForm(),
        name: data.name,
        issue_number: data.issue_number ?? "",
        series: data.series ?? "",
        publisher: data.publisher ?? "",
        barcode: data.barcode ?? "",
      });
      setBook({ confidence: data.confidence, detected_text: data.detected_text });
      setErrors({});
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

  async function save() {
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const candidate = {
      id: null,
      name: form.name,
      issue_number: form.issue_number.trim() || null,
      barcode: form.barcode.trim() || null,
      category_id: form.category_id || null,
      product_type: form.product_type,
      series: form.series.trim() || null,
      publisher: form.publisher.trim() || null,
      vendor_id: form.vendor_id || null,
      selling_price: num(form.selling_price) ?? 0,
      cost_price: num(form.cost_price),
      // 與 EMPTY_PRODUCT_FORM 的預設一致；要細調的話在商品編輯那一頁改。
      low_stock_alert: 5,
      pack_size: 1,
      base_product_id: null,
      image_key: null,
      notes: null,
      purchase: form.with_purchase
        ? {
            quantity: Number(form.quantity || 0),
            cost_price: num(form.cost_price),
            vendor: null,
            purchase_date: form.purchase_date,
          }
        : null,
    };

    const parsed = invProductSchema.safeParse(candidate);
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const issue of parsed.error.issues) map[String(issue.path[0])] = issue.message;
      setErrors(map);
      toast.error(parsed.error.issues[0]?.message ?? "請檢查輸入的內容");
      return;
    }

    setBusy(true);
    try {
      const { saveProduct } = await import("@/lib/admin/fns/inv-products");
      const result = await saveProduct({ data: parsed.data });
      toast.success(result.purchase_created ? "商品已新增，並建立了一筆進貨" : "商品已新增");
      reset();
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請再試一次");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Camera className="h-4 w-4" aria-hidden="true" />
            拍照辨識書封
          </DialogTitle>
          <DialogDescription>
            {step === "capture"
              ? "拍一張封面，AI 讀出書名、期數、系列、出版社與條碼。"
              : productApprovalOn
                ? "逐欄確認後建立。新增的商品會進入待審核，核准之後才會出現在櫃檯。"
                : "逐欄確認後建立。審核已關閉，新增的商品會直接生效。"}
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
            hint="封面拍滿、書名與條碼要清楚"
            onImage={handleImage}
          />
        ) : (
          <div className="space-y-4">
            {book ? (
              <ProductOCRConfidence
                confidence={book.confidence}
                detectedText={book.detected_text}
              />
            ) : null}
            <ProductOCRFields
              form={form}
              onFormChange={setForm}
              errors={errors}
              categories={categories}
              vendors={vendors}
            />
          </div>
        )}

        <DialogFooter>
          {step === "confirm" && !failure ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setStep("capture")}>
                重新拍照
              </Button>
              <Button variant="ghost" disabled={busy} onClick={goManual}>
                改用手動輸入
              </Button>
            </>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {step === "confirm" && !failure ? (
            <Button onClick={save} disabled={busy}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              建立商品
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
