/**
 * 新增一張在庫異動單。
 *
 * ⚠️ payload 裡**沒有 status**，也沒有成本。要不要進待審是
 *    inv.stock_adjustment_initial_status() 在資料庫算的；出庫的成本由 FIFO trigger 算，
 *    進庫的用商品成本。從瀏覽器送成本進來等於讓人自己填毛利。
 *
 * ⚠️ 負庫存只**軟警告**，不擋。書店真的會出現「架上明明沒有但系統說有三本」，這時候
 *    要能把帳做平；擋住只會逼店員去改商品主檔的庫存數字，那條路完全沒有紀錄。
 *
 * ⚠️ 商品清單走 server 端搜尋（listStockCountProducts 的 keyword），不是整表載進來。
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, Loader2, Save } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ADJUSTMENT_CATEGORY_OPTIONS,
  ADJUSTMENT_REASON_OPTIONS,
} from "@/lib/admin/inv-adjustment-labels";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import {
  invAdjustmentSchema,
  INV_PRODUCT_TYPE_LABELS,
  type InvAdjustmentCategory,
  type InvAdjustmentReason,
} from "@/lib/admin/schemas";
import type { StockCountProductRow } from "@/server/repos/inv-adjustments";

/** Radix Select 不接受空字串當 SelectItem 的 value，所以「不指定」用這個哨兵值。 */
const NONE = "__none__";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  approvalOn: boolean;
  onSaved: () => Promise<void>;
};

export function AdjustmentFormDialog({ open, onOpenChange, approvalOn, onSaved }: Props) {
  const [date, setDate] = useState(todayInTaipei());
  const [category, setCategory] = useState<InvAdjustmentCategory>("EXP");
  const [keyword, setKeyword] = useState("");
  const [products, setProducts] = useState<StockCountProductRow[]>([]);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<InvAdjustmentReason | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState<"draft" | "submit" | null>(null);

  useEffect(() => {
    if (!open) return;
    setDate(todayInTaipei());
    setCategory("EXP");
    setKeyword("");
    setProductId("");
    setQuantity("");
    setReason(null);
    setNotes("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 打字停 300ms 才問一次資料庫。
    const timer = setTimeout(async () => {
      try {
        const { listStockCountProducts } = await import("@/lib/admin/fns/inv-adjustments");
        const page = await listStockCountProducts({
          data: {
            keyword: keyword.trim() === "" ? null : keyword.trim(),
            categoryId: null,
            productType: null,
            lowStockOnly: false,
            page: 0,
            pageSize: 50,
          },
        });
        if (!cancelled) setProducts(page.rows);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "商品清單讀取失敗");
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, keyword]);

  const selected = products.find((p) => p.inv_product_id === productId) ?? null;
  const qty = quantity.trim() === "" ? null : Number(quantity);
  const after = selected && qty !== null && !Number.isNaN(qty) ? selected.stock_quantity + qty : null;

  async function save(submit: boolean) {
    const parsed = invAdjustmentSchema.safeParse({
      product_id: productId,
      adjustment_date: date,
      category,
      quantity: quantity.trim() === "" ? Number.NaN : Number(quantity),
      reason,
      notes: notes.trim() === "" ? null : notes,
      submit,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查填寫的內容");
      return;
    }

    setSaving(submit ? "submit" : "draft");
    try {
      const { saveAdjustment } = await import("@/lib/admin/fns/inv-adjustments");
      const result = await saveAdjustment({ data: parsed.data });
      const no = result.adjustment_number ?? "";
      if (!submit) {
        toast.success(`已存為草稿 ${no}，可稍後再送出`);
      } else if (result.needs_approval) {
        toast.success(`${no} 已送出待審核，核准後庫存才會更新`);
      } else {
        toast.success(`${no} 已確認，庫存已更新`);
      }
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "異動單儲存失敗");
    } finally {
      setSaving(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => saving === null && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">新增在庫異動</DialogTitle>
          <DialogDescription>
            登記報廢、贈送、領用等非銷售的庫存變動。
            {approvalOn
              ? "在庫異動目前需要審核：送出之後會進入待審核，核准後庫存才會更新。"
              : "在庫異動目前不需要審核，送出後庫存立即更新。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="adjf-date">異動日期</Label>
            <Input
              id="adjf-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>異動類別</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as InvAdjustmentCategory)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ADJUSTMENT_CATEGORY_OPTIONS.map((o) => (
                  <SelectItem key={o.code} value={o.code}>
                    {o.label}
                    <span className="ml-2 text-xs text-muted-foreground">— {o.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="adjf-search">商品</Label>
          <Input
            id="adjf-search"
            placeholder="先搜尋：商品名稱、期數、系列、條碼"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger>
              <SelectValue placeholder="從搜尋結果裡選一件商品" />
            </SelectTrigger>
            <SelectContent>
              {products.map((p) => (
                <SelectItem key={p.inv_product_id} value={p.inv_product_id}>
                  {p.name}
                  {p.issue_number ? ` #${p.issue_number}` : ""}（庫存 {p.stock_quantity}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected ? (
            <p className="text-xs text-muted-foreground">
              現有庫存 {selected.stock_quantity} 件・
              {INV_PRODUCT_TYPE_LABELS[selected.product_type as keyof typeof INV_PRODUCT_TYPE_LABELS] ??
                selected.product_type}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="adjf-qty">異動數量</Label>
            <Input
              id="adjf-qty"
              type="number"
              step={1}
              placeholder="負值＝扣帳，正值＝回補"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>原因（選填）</Label>
            <Select
              value={reason ?? NONE}
              onValueChange={(v) => setReason(v === NONE ? null : (v as InvAdjustmentReason))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>不指定</SelectItem>
                {ADJUSTMENT_REASON_OPTIONS.map((o) => (
                  <SelectItem key={o.code} value={o.code}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {after !== null && after < 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <span>
              注意：異動後庫存將為負值（{after}）。這張單還是可以送出 —— 帳做平比擋住重要，
              但請確認數量沒有打錯。
            </span>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="adjf-notes">備註</Label>
          <Textarea
            id="adjf-notes"
            rows={2}
            placeholder="補充說明（選填）"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={saving !== null}
            onClick={() => void save(false)}
          >
            {saving === "draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            存為草稿
          </Button>
          <Button className="gap-1.5" disabled={saving !== null} onClick={() => void save(true)}>
            {saving === "submit" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle className="h-4 w-4" />
            )}
            送出
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
