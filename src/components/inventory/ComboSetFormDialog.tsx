/**
 * 新增／編輯套餐。
 *
 * ⚠️ 送出去的 payload **沒有 approval_status，也沒有 amount / unit_price /
 *    cost_price**。狀態由 inv.initial_approval_status() 在資料庫算（改了組成品項或
 *    組合價會重新進待審），金額由 inv.allocate_combo_amounts() 在結帳當下分攤。
 *    這四個欄位就算硬塞進 body 也沒有任何一行程式會讀 —— 來源系統是在瀏覽器算完
 *    approval_status 再連同 insert 送出去，於是「要不要審核」變成前端說了算。
 *
 * ⚠️ 下面那張分攤預覽是**預覽**，不會被送出。它與資料庫用同一套最大餘額法（見
 *    lib/admin/combo-allocation.ts），但資料庫才是權威。
 */
import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ComboSetAllocationPreview,
  type PreviewItem,
} from "@/components/inventory/ComboSetAllocationPreview";
import { ComboSetItemEditor } from "@/components/inventory/ComboSetItemEditor";
import { comboSetSchema, type ComboItemValues } from "@/lib/admin/schemas";
import type { AdminComboSetRow } from "@/server/repos/inv-combos";
import type { PosProduct } from "@/server/repos/inv-sales";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  approvalOn: boolean;
  /** null = 新增。 */
  editing: AdminComboSetRow | null;
  products: PosProduct[];
  onSaved: () => Promise<void>;
};

export function ComboSetFormDialog({
  open,
  onOpenChange,
  approvalOn,
  editing,
  products,
  onSaved,
}: Props) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [items, setItems] = useState<ComboItemValues[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 開啟時重置。編輯的話還要把既有的組成品項抓回來 —— 清單頁那份是給表格用的，
  // 這裡重抓一次才不會拿到別人剛剛改過之前的舊內容。
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setPrice(editing ? String(editing.selling_price) : "");
    setNotes(editing?.notes ?? "");
    setIsActive(editing?.is_active ?? true);
    setItems([]);
    if (!editing) return;

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { getAdminComboSet } = await import("@/lib/admin/fns/inv-combos");
        const result = await getAdminComboSet({ data: { id: editing.combo_set_id } });
        if (cancelled) return;
        setItems(result.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })));
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "組成品項讀取失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, editing]);

  const priceNumber = price.trim() === "" ? Number.NaN : Number(price);
  const previewItems: PreviewItem[] = items.map((item) => {
    const product = products.find((p) => p.inv_product_id === item.product_id);
    return {
      product_id: item.product_id,
      quantity: item.quantity,
      selling_price: product?.selling_price ?? null,
      name: product?.name ?? "未知商品",
      issue_number: product?.issue_number ?? null,
    };
  });

  async function save() {
    const parsed = comboSetSchema.safeParse({
      id: editing?.combo_set_id ?? null,
      name,
      selling_price: priceNumber,
      notes: notes.trim() === "" ? null : notes,
      is_active: isActive,
      items,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查填寫的內容");
      return;
    }

    setSaving(true);
    try {
      const { saveComboSet } = await import("@/lib/admin/fns/inv-combos");
      const result = await saveComboSet({ data: parsed.data });
      toast.success(
        result.approval_status === "approved"
          ? `「${parsed.data.name}」已儲存（${result.item_count} 件組成品項）`
          : `「${parsed.data.name}」已儲存待審核，核准後才能販售`,
      );
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "套餐儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{editing ? "編輯套餐" : "新增套餐"}</DialogTitle>
          <DialogDescription>
            一個套餐只有一個組合價，賣掉的時候會依組成品項拆成各自的營收。
            {approvalOn
              ? "套餐目前需要審核：儲存之後會進入待審核，核准後才能販售。"
              : "套餐目前不需要審核，儲存後即可販售。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="combo-name">套餐名稱</Label>
            <Input
              id="combo-name"
              placeholder="例：小誌三本組"
              value={name}
              disabled={saving}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="combo-price">組合價</Label>
            <Input
              id="combo-price"
              type="number"
              min={0}
              step={1}
              placeholder="整組賣多少錢"
              value={price}
              disabled={saving}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="combo-notes">備註</Label>
          <Textarea
            id="combo-notes"
            rows={2}
            placeholder="補充說明（選填）"
            value={notes}
            disabled={saving}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border p-3">
          <Switch
            id="combo-active"
            checked={isActive}
            disabled={saving}
            onCheckedChange={setIsActive}
          />
          <Label htmlFor="combo-active" className="cursor-pointer">
            上架（櫃檯看得到、賣得動）
          </Label>
        </div>

        {loading ? (
          <div className="flex h-24 items-center justify-center rounded-md border border-border">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ComboSetItemEditor
            items={items}
            products={products}
            disabled={saving}
            onChange={setItems}
          />
        )}

        <ComboSetAllocationPreview
          sellingPrice={Number.isNaN(priceNumber) ? 0 : priceNumber}
          items={previewItems}
        />

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button className="gap-1.5" disabled={saving || loading} onClick={() => void save()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            儲存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
