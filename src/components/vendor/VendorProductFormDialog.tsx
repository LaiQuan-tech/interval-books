/**
 * 廠商送審一件商品的表單。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 這張表單裡沒有的五個欄位，比它有的八個欄位重要
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 表單只有：name / issue_number / series / publisher / barcode / notes /
 * image_key / selling_price（建議售價）。以下五個**不在這裡，也不可以加進來**，
 * 因為它們全部由資料庫決定（0019 §7.7）：
 *
 *   · approval_status —— 寫死 'pending'，而且**不看 approval_settings**（§0.2）。
 *     廠商送的是外部投稿，跟「店家信不信自己的店員」無關；把審核關掉是店家對內部
 *     同事的信任，不該連帶讓外部投稿直接上架。
 *   · vendor_id ——由 vendor_my_id() 從 session 的 userId 推導。表單送得出 vendor_id
 *     的那一刻，廠商就能把商品掛到別家名下。
 *   · stock_quantity —— 一律 0。廠商說自己有幾本不算數，庫存只能由進貨／盤點改，
 *     否則庫存數字會有兩個互相打架的來源。
 *   · cost_price —— 成本是店家的資訊（店家用多少錢跟你進的），不是廠商申報的欄位。
 *   · product_type —— 一律 consignment（寄售）。
 *
 * 這五個就算硬塞進 payload 也不會有任何一行程式讀它：vendorProductSubmitSchema
 * 沒有這些 key，zod 會直接丟掉，資料庫函式的簽名裡也沒有對應參數。所以「加一個
 * 欄位試試看」不會壞掉，只會安靜地沒有效果 —— 這正是要把理由寫在這裡的原因。
 *
 * ── selling_price 是「建議」售價 ──────────────────────────────────────────
 * 送進來的是廠商的**建議**價，實際賣多少由書店核准時決定。畫面上的 label 必須寫
 * 「建議售價」，寫成「售價」廠商會以為自己在定價。
 *
 * ── 哪裡容易寫錯 ──────────────────────────────────────────────────────────
 * ⚠️ payload 裡沒有 vendorId，這不是疏漏。整個廠商入口沒有任何一支 server fn 收
 *    vendorId —— UI 這一側連自己是哪一家的 id 都不知道（見 routes/vendor/_shell.tsx
 *    檔頭）。要顯示的名稱從 getCurrentVendor / myVendorProfile 拿。
 *
 * ⚠️ 圖片一定要先在瀏覽器壓縮再送。Vercel serverless 的 request body 上限約 4.5MB，
 *    手機直出的照片一張就可能超過 —— 與 components/admin/ImageField.tsx 同一條理由，
 *    所以共用 lib/admin/image-compress.ts 的同一組常數，不要在這裡另外寫一份數字。
 *
 * ⚠️ 本地的 safeParse 只是「快速失敗」，不是驗證邊界。真正的驗證是 server 端同一份
 *    vendorProductSubmitSchema 再跑一次。
 */
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Upload, X } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { vendorProductSubmitSchema } from "@/lib/admin/schemas";
import {
  compressImage,
  extensionFor,
  IMAGE_MAX_EDGE_PX,
  IMAGE_WEBP_QUALITY,
} from "@/lib/admin/image-compress";
import { imageFor } from "@/lib/images";
import type { VendorPortalProduct } from "@/server/repos/inv-vendors";

type FormState = {
  name: string;
  issue_number: string;
  series: string;
  publisher: string;
  barcode: string;
  notes: string;
  image_key: string | null;
  /** 字串，因為 <input> 的值本來就是字串。送出前才轉數字，空字串轉成 NaN 讓 zod 出訊息。 */
  selling_price: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  issue_number: "",
  series: "",
  publisher: "",
  barcode: "",
  notes: "",
  image_key: null,
  selling_price: "",
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 送審新商品；有值 = 修改自己還在待審核的那一件。 */
  editing: VendorPortalProduct | null;
  /** 送出成功之後由呼叫端重抓資料（toast + router.invalidate()）。 */
  onSaved: () => Promise<void> | void;
};

export function VendorProductFormDialog({ open, onOpenChange, editing, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const isEdit = editing !== null;

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (editing) {
      setForm({
        name: editing.name,
        issue_number: editing.issue_number ?? "",
        series: editing.series ?? "",
        publisher: editing.publisher ?? "",
        barcode: editing.barcode ?? "",
        notes: editing.notes ?? "",
        image_key: editing.image_key,
        selling_price: editing.selling_price === null ? "" : String(editing.selling_price),
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, editing]);

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("請選擇圖片檔案");
      return;
    }
    setUploading(true);
    try {
      // 先壓再送，理由見檔頭。
      const compressed = await compressImage(file, {
        maxEdge: IMAGE_MAX_EDGE_PX,
        quality: IMAGE_WEBP_QUALITY,
      });
      const formData = new FormData();
      formData.append("file", compressed, `upload.${extensionFor(compressed)}`);
      const { uploadProductImage } = await import("@/lib/admin/fns/vendor-portal");
      const result = await uploadProductImage({ data: formData });
      setForm((f) => ({ ...f, image_key: result.key }));
      toast.success("圖片已上傳");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "圖片上傳失敗，請再試一次");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit() {
    // ⚠️ 這個物件裡沒有 vendor_id / approval_status / stock_quantity / cost_price /
    //    product_type。五個都由資料庫決定，見檔頭。
    const candidate = {
      id: editing?.inv_product_id ?? null,
      name: form.name,
      issue_number: form.issue_number.trim() || null,
      series: form.series.trim() || null,
      publisher: form.publisher.trim() || null,
      barcode: form.barcode.trim() || null,
      notes: form.notes.trim() || null,
      image_key: form.image_key,
      // 空字串會變成 NaN，被 schema 的 .finite() 擋下來並回「建議售價必須是數字」。
      // 這裡刻意不預設成 0 —— 0 是一個合法的價格，會安靜地送出去。
      selling_price: form.selling_price.trim() === "" ? NaN : Number(form.selling_price),
    };

    const parsed = vendorProductSubmitSchema.safeParse(candidate);
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const issue of parsed.error.issues) map[String(issue.path[0])] = issue.message;
      setErrors(map);
      toast.error(parsed.error.issues[0]?.message ?? "請檢查輸入的內容");
      return;
    }

    setSaving(true);
    try {
      const { submitProduct } = await import("@/lib/admin/fns/vendor-portal");
      const result = await submitProduct({ data: parsed.data });
      toast.success(result.created ? "已送出審核" : "已更新，仍在等待書店審核");
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "送審失敗，請再試一次");
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || uploading;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{isEdit ? "修改送審內容" : "送審新商品"}</DialogTitle>
          <DialogDescription>
            送出之後會進入書店的待審核清單。核准之前你都還可以回來修改或撤回；
            核准之後這件商品就由書店維護，這裡只能檢視。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="商品名稱" required error={errors.name}>
            <Input
              value={form.name}
              disabled={busy}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="系列" error={errors.series}>
              <Input
                value={form.series}
                disabled={busy}
                onChange={(e) => setForm({ ...form, series: e.target.value })}
              />
            </Field>
            <Field label="期數" error={errors.issue_number}>
              <Input
                value={form.issue_number}
                disabled={busy}
                onChange={(e) => setForm({ ...form, issue_number: e.target.value })}
              />
            </Field>
            <Field label="出版者" error={errors.publisher}>
              <Input
                value={form.publisher}
                disabled={busy}
                onChange={(e) => setForm({ ...form, publisher: e.target.value })}
              />
            </Field>
            <Field label="條碼 / ISBN" error={errors.barcode}>
              <Input
                value={form.barcode}
                disabled={busy}
                onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              />
            </Field>
          </div>

          {/* 「建議」兩個字不能省，見檔頭。 */}
          <Field
            label="建議售價"
            required
            error={errors.selling_price}
            hint="這是你建議的定價。實際售價由書店核准時決定。"
          >
            <Input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={form.selling_price}
              disabled={busy}
              onChange={(e) => setForm({ ...form, selling_price: e.target.value })}
            />
          </Field>

          <Field label="商品照片" error={errors.image_key}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="relative aspect-square w-28 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                {form.image_key ? (
                  <img
                    src={imageFor(form.image_key, "")}
                    alt="商品照片預覽"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <ImagePlus className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                  </div>
                )}
                {uploading ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-background/70">
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                  </div>
                ) : null}
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => handleFile(e.target.files)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Upload className="h-4 w-4" aria-hidden="true" />
                    )}
                    上傳照片
                  </Button>
                  {form.image_key ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      disabled={busy}
                      onClick={() => setForm({ ...form, image_key: null })}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                      清除
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  會自動壓縮並轉為 WebP（最長邊 {IMAGE_MAX_EDGE_PX}px）。僅接受 JPEG、PNG、WebP。
                </p>
              </div>
            </div>
          </Field>

          <Field
            label="備註"
            error={errors.notes}
            hint="想讓書店知道的事，例如出版背景或補書方式。"
          >
            <Textarea
              rows={3}
              value={form.notes}
              disabled={busy}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={submit}>
            {saving ? "送出中…" : isEdit ? "更新送審內容" : "送出審核"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
