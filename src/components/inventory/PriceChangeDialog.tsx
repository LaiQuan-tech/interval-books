/**
 * 送出調價。
 *
 * ── 這一頁接的是來源系統從來沒有接起來的三個欄位 ──────────────────────────
 * pending_cost_price / pending_selling_price / price_change_status 在來源的
 * migration 裡就存在，approval_settings 也有 price_changes 這一列，
 * useUserPermissions 也定義了 approve_price_changes —— 但整個 src/ 沒有任何一行
 * 讀過或寫過它們（993 筆商品的 price_change_status 全部是 NULL）。改價在來源是
 * **立即生效**的，三條路徑（編輯表單、批次更新、Excel 匯入）都一樣。
 *
 * 所以這裡不是「照搬」，是照那組欄位與那個開關的名字把它接起來：
 * 送出 → pending → 有 approve_price_changes 的人核准 → 才寫進 selling_price。
 */
import { useEffect, useState } from "react";
import { Loader2, Tag } from "lucide-react";
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
import { priceChangeSchema } from "@/lib/admin/schemas";
import type { AdminProductRow } from "@/server/repos/inv-products";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: AdminProductRow | null;
  priceApprovalOn: boolean;
  onDone: () => void | Promise<void>;
};

export function PriceChangeDialog({ open, onOpenChange, product, priceApprovalOn, onDone }: Props) {
  const [selling, setSelling] = useState("");
  const [cost, setCost] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !product) return;
    // 預填目前的價格 —— 調價的人通常只改其中一個，另一個要保持原樣而不是變成空的
    // （空的會被當成 0，那是一次靜默的破壞）。
    setSelling(product.selling_price === null ? "" : String(product.selling_price));
    setCost(product.cost_price === null ? "" : String(product.cost_price));
  }, [open, product]);

  async function submit() {
    if (!product) return;
    const parsed = priceChangeSchema.safeParse({
      id: product.inv_product_id,
      selling_price: selling.trim() === "" ? Number.NaN : Number(selling),
      cost_price: cost.trim() === "" ? null : Number(cost),
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查輸入的價格");
      return;
    }

    setSaving(true);
    try {
      const { requestPriceChange } = await import("@/lib/admin/fns/inv-products");
      const result = await requestPriceChange({ data: parsed.data });
      toast.success(
        result.pending
          ? `「${result.name}」的調價已送出，核准後才會生效`
          : `「${result.name}」的價格已更新`,
      );
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "調價送出失敗");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Tag className="h-4 w-4" aria-hidden="true" />
            調價
          </DialogTitle>
          <DialogDescription>
            {product ? `「${product.name}」` : ""}
            {priceApprovalOn
              ? "送出之後會進入待審核，有審核調價權限的人核准之後才會生效。目前的價格在那之前不會變。"
              : "調價審核目前是關閉的，送出會直接生效。"}
          </DialogDescription>
        </DialogHeader>

        {product?.price_change_status === "pending" ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            這件商品已經有一筆待審的調價（售價 →{" "}
            {product.pending_selling_price === null
              ? "—"
              : `NT$ ${Number(product.pending_selling_price).toLocaleString("zh-TW")}`}
            ）。再送一次會蓋掉它。
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pc-selling">新售價</Label>
            <Input
              id="pc-selling"
              type="number"
              min={0}
              step="0.01"
              value={selling}
              onChange={(e) => setSelling(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              目前 NT$ {Number(product?.selling_price ?? 0).toLocaleString("zh-TW")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pc-cost">新成本</Label>
            <Input
              id="pc-cost"
              type="number"
              min={0}
              step="0.01"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              目前 NT$ {Number(product?.cost_price ?? 0).toLocaleString("zh-TW")}
              ・留空代表不動它
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {priceApprovalOn ? "送出調價" : "直接改價"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
