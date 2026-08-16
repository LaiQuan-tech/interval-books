/**
 * 新增／編輯一筆進貨。
 *
 * ── 編輯時商品鎖住，數量可以改 ────────────────────────────────────────────
 * 換商品等於整批貨連同 FIFO 批次一起搬家，所以編輯時商品是唯讀的（要換就刪掉重
 * 開，savePurchase() 在編輯分支根本不送 product_id）。數量相反，是可以改的：0017
 * 的 trigger 會把 remaining_quantity 與 products.stock_quantity 一起對齊。改到比
 * 已經出庫的量還小會被資料庫擋下來，而那句話是寫給店員看的整句中文，**原樣**
 * toast 出來。
 *
 * ── 沒有 approval_status 欄位 ─────────────────────────────────────────────
 * 它由 inv.initial_approval_status('purchases') 在資料庫算（fail-closed）。表單只
 * 負責顯示「送出後會怎樣」，不自己查設定再決定 —— 那份設定在瀏覽器裡還沒載完時
 * 會 fallback 成錯的值。
 *
 * ⚠️ 沒有 LocalizedField：進銷存是單語。三語只在「上架」那一頁出現。
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { PurchaseFormFields } from "@/components/inventory/PurchaseFormFields";
import {
  EMPTY_PURCHASE_FORM,
  type PurchaseFormState,
} from "@/components/inventory/purchase-form-state";
import type { VendorOption } from "@/components/inventory/VendorSelect";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import { invPurchaseSchema } from "@/lib/admin/schemas";
import type { AdminPurchaseRow, ProductPickerRow } from "@/server/repos/inv-purchases";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purchase: AdminPurchaseRow | null;
  products: ProductPickerRow[];
  vendors: VendorOption[];
  /** 只影響提示文字。真正的 approval_status 由 server 算。 */
  approvalOn: boolean;
  onSaved: () => void | Promise<void>;
};

export function PurchaseFormDialog({
  open,
  onOpenChange,
  purchase,
  products,
  vendors,
  approvalOn,
  onSaved,
}: Props) {
  const [form, setForm] = useState<PurchaseFormState>(EMPTY_PURCHASE_FORM);
  const [keyword, setKeyword] = useState("");
  const [saving, setSaving] = useState(false);

  const isEdit = purchase !== null;

  useEffect(() => {
    if (!open) return;
    setKeyword("");
    if (purchase) {
      setForm({
        product_id: purchase.product_id,
        item_name: purchase.item_name ?? "",
        purchase_date: purchase.purchase_date,
        quantity: String(purchase.quantity),
        unit_cost: purchase.unit_cost === null ? "" : String(purchase.unit_cost),
        vendor: { vendor_id: purchase.vendor_id, vendor: purchase.vendor_text },
        publisher: purchase.publisher ?? "",
        notes: purchase.notes ?? "",
        expiry_date: purchase.expiry_date ?? "",
        expiry_alert_days:
          purchase.expiry_alert_days === null ? "" : String(purchase.expiry_alert_days),
      });
    } else {
      // ⚠️ todayInTaipei()，不是 toISOString()。purchase_date 是 date，UTC 換算在
      //    台北時間晚上八點之後會把今天寫成明天。
      setForm({ ...EMPTY_PURCHASE_FORM, purchase_date: todayInTaipei() });
    }
  }, [open, purchase]);

  const matches = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const pool = q
      ? products.filter((p) =>
          `${p.name} ${p.issue_number ?? ""} ${p.series ?? ""} ${p.barcode ?? ""}`
            .toLowerCase()
            .includes(q),
        )
      : products;
    return pool.slice(0, 30);
  }, [keyword, products]);

  function pickProduct(p: ProductPickerRow) {
    setForm({
      ...form,
      product_id: p.inv_product_id,
      // 進貨品名預設跟商品同名，店員可以改成進貨單上的寫法。已經打過字就不要蓋掉。
      item_name: form.item_name.trim() === "" ? p.name : form.item_name,
      unit_cost:
        form.unit_cost.trim() === "" && p.cost_price !== null
          ? String(p.cost_price)
          : form.unit_cost,
    });
  }

  async function submit() {
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const candidate = {
      id: purchase?.purchase_id ?? null,
      product_id: form.product_id,
      item_name: form.item_name.trim() || null,
      purchase_date: form.purchase_date,
      quantity: Number(form.quantity || 0),
      unit_cost: num(form.unit_cost),
      vendor_id: form.vendor.vendor_id,
      vendor: form.vendor.vendor?.trim() || null,
      publisher: form.publisher.trim() || null,
      notes: form.notes.trim() || null,
      expiry_date: form.expiry_date || null,
      expiry_alert_days: num(form.expiry_alert_days),
    };

    const parsed = invPurchaseSchema.safeParse(candidate);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查輸入的內容");
      return;
    }

    setSaving(true);
    try {
      const { savePurchase } = await import("@/lib/admin/fns/inv-purchases");
      const result = await savePurchase({ data: parsed.data });
      toast.success(
        result.created
          ? result.needs_approval
            ? "進貨已建立，等待審核 —— 核准之後庫存才會加上去"
            : "進貨已建立，庫存已更新"
          : "進貨已更新",
      );
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      // 「改到比已出庫量還小」那句守衛是資料庫寫的整句中文，原樣顯示。
      toast.error(err instanceof Error ? err.message : "儲存失敗，請再試一次");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{isEdit ? "編輯進貨" : "新增進貨"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "商品不能換 —— 換商品等於整批貨連同 FIFO 批次搬家，要換請刪掉重開。數量改了之後庫存會跟著調整。"
              : approvalOn
                ? "新增的進貨會進入待審核，核准之後庫存才會加上去。"
                : "審核已關閉，新增的進貨會直接生效，庫存立刻加上去。"}
          </DialogDescription>
        </DialogHeader>

        <PurchaseFormFields
          form={form}
          setForm={setForm}
          onPickProduct={pickProduct}
          matches={matches}
          keyword={keyword}
          onKeywordChange={setKeyword}
          vendors={vendors}
          saving={saving}
          lockedProduct={
            purchase ? { name: purchase.product_name, issue_number: purchase.issue_number } : null
          }
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {isEdit ? "儲存" : "新增"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
