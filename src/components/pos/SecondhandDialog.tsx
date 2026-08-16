/**
 * 二手書入帳。
 *
 * ── 為什麼這個對話框裡沒有商品選擇器，而且不會有 ──────────────────────────
 * 二手書**不進 inv.products**：一本一件、沒有進貨批次、沒有庫存、沒有 FIFO 成本。
 * 它在資料庫裡是 inv.sales 上的一個旗標（is_secondhand），不是一種商品。
 *
 * 0018 檔頭問題三查得很清楚：正式庫 45 筆二手銷售的 product_id 全部是 NULL，
 * 而 inv.sales 現在有一條 CHECK（sales_secondhand_has_no_product）擋著 ——
 * 只要這張單帶了 product_id，資料庫會直接拒收。所以加一個商品選擇器不是「多一個
 * 方便的功能」，是做出一張永遠送不出去的表單，而它擋的正是「拿一件真商品當二手
 * 賣」：那會靜默跳過扣庫存。
 *
 * ⚠️ payload 裡沒有 amount、沒有 cost_price、沒有 approval_status —— 金額由
 *    inv_secondhand_checkout() 算（數量 × 售價），成本恆為 NULL（沒有進貨批次就
 *    沒有成本）。這裡送的 unit_price 是店員開的售價，資料庫沒有商品主檔可查，
 *    只有人知道這本書賣多少。
 */
import { useEffect, useState } from "react";
import { BookMarked, Loader2 } from "lucide-react";
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
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import { secondhandSaleSchema } from "@/lib/admin/schemas";
import type { PosPaymentMethod } from "@/server/repos/inv-sales";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paymentMethods: PosPaymentMethod[];
  defaultPaymentMethodId: string | null;
  /** 入帳成功之後重跑 loader。這個 repo 沒有 react-query。 */
  onSaved: () => Promise<void>;
};

export function SecondhandDialog({
  open,
  onOpenChange,
  paymentMethods,
  defaultPaymentMethodId,
  onSaved,
}: Props) {
  const [itemName, setItemName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(todayInTaipei());
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(defaultPaymentMethodId);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setItemName("");
    setQuantity("1");
    setPrice("");
    setDate(todayInTaipei());
    setPaymentMethodId(defaultPaymentMethodId);
    setNotes("");
  }, [open, defaultPaymentMethodId]);

  const qty = quantity.trim() === "" ? Number.NaN : Number(quantity);
  const amount = Number.isFinite(qty) && price.trim() !== "" ? qty * Number(price) : null;

  async function save() {
    const parsed = secondhandSaleSchema.safeParse({
      item_name: itemName,
      quantity: qty,
      unit_price: price.trim() === "" ? Number.NaN : Number(price),
      sale_date: date,
      payment_method_id: paymentMethodId,
      notes: notes.trim() === "" ? null : notes,
      // ← 這裡就到底了。沒有 product_id、沒有 amount、沒有 cost_price。
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查填寫的內容");
      return;
    }

    setSaving(true);
    try {
      const { secondhandCheckout } = await import("@/lib/admin/fns/inv-combos");
      const result = await secondhandCheckout({ data: parsed.data });
      toast.success(
        `已入帳「${result.item_name}」${result.quantity} 本，NT$ ${Number(result.amount).toLocaleString("zh-TW")}`,
      );
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "二手書入帳失敗，請再試一次");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookMarked className="h-4 w-4" aria-hidden="true" />
            二手書入帳
          </DialogTitle>
          <DialogDescription>
            二手書不進商品主檔、沒有庫存也沒有成本 —— 一本一件、賣掉就沒了，
            所以這裡只記一筆營收，不動任何庫存數字。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="sh-name">書名</Label>
          <Input
            id="sh-name"
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            placeholder="直接打書名，不用先建商品"
            maxLength={200}
            disabled={saving}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sh-qty">數量</Label>
            <Input
              id="sh-qty"
              type="number"
              min={1}
              step={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="tabular-nums"
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sh-price">售價（一本）</Label>
            <Input
              id="sh-price"
              type="number"
              min={0}
              step={1}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="這本書賣多少"
              className="tabular-nums"
              disabled={saving}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sh-date">日期</Label>
            <Input
              id="sh-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sh-payment">付款方式</Label>
            <Select
              value={paymentMethodId ?? ""}
              onValueChange={(v) => setPaymentMethodId(v || null)}
              disabled={saving}
            >
              <SelectTrigger id="sh-payment">
                <SelectValue placeholder="選擇付款方式" />
              </SelectTrigger>
              <SelectContent>
                {paymentMethods.map((m) => (
                  <SelectItem key={m.payment_method_id} value={m.payment_method_id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sh-notes">備註（選填）</Label>
          <Textarea
            id="sh-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="例如：客人寄賣、書況說明"
            maxLength={500}
            disabled={saving}
          />
        </div>

        {amount !== null ? (
          <p className="text-sm text-muted-foreground">
            這一筆入帳金額{" "}
            <span className="font-medium tabular-nums text-foreground">
              NT$ {amount.toLocaleString("zh-TW")}
            </span>
            （實際金額以資料庫算的為準）
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button className="gap-1.5" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            入帳
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
