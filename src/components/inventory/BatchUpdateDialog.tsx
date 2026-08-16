/**
 * 批次更新選取的商品。
 *
 * 五個欄位各有一個 checkbox 決定要不要納入更新 —— 沒有勾的欄位在 patch 裡根本
 * 不會出現，而 inv_batch_update_products() 是用 `p_patch ? 'key'` 判斷要不要動，
 * 所以「沒勾」與「勾了但填空」是兩件不同的事。這個區別很重要：來源的批次更新
 * 用 `Object.keys(updateData).length > 0` 判斷，於是「把成本改成 0」與「不要改
 * 成本」在某些路徑上長得一樣。
 *
 * ⚠️ 價格一樣走調價審核。批次是最容易出事的操作（一次改 200 件），所以它更該
 *    有審核，不是更不該 —— 來源的批次更新是三條「改價不經審核」路徑之一。
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { batchUpdateSchema, INV_PRODUCT_TYPES, INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";
import type { AdminCategory, AdminVendor } from "@/server/repos/inv-products";

const NONE = "none";
type PriceMode = "set" | "percent" | "amount";

const MODE_LABELS: Record<PriceMode, string> = {
  set: "直接指定為",
  percent: "增減百分比 (%)",
  amount: "增減金額",
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  categories: AdminCategory[];
  vendors: AdminVendor[];
  priceApprovalOn: boolean;
  onDone: () => void | Promise<void>;
};

export function BatchUpdateDialog({
  open,
  onOpenChange,
  selectedIds,
  categories,
  vendors,
  priceApprovalOn,
  onDone,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [use, setUse] = useState({
    category: false,
    type: false,
    vendor: false,
    selling: false,
    cost: false,
  });
  const [categoryId, setCategoryId] = useState(NONE);
  const [productType, setProductType] = useState<(typeof INV_PRODUCT_TYPES)[number]>("outright");
  const [vendorId, setVendorId] = useState(NONE);
  const [selling, setSelling] = useState({ mode: "set" as PriceMode, value: "" });
  const [cost, setCost] = useState({ mode: "set" as PriceMode, value: "" });

  const anySelected = Object.values(use).some(Boolean);

  async function submit() {
    const patch: Record<string, unknown> = {};
    if (use.category) patch.category_id = categoryId === NONE ? null : categoryId;
    if (use.type) patch.product_type = productType;
    if (use.vendor) patch.vendor_id = vendorId === NONE ? null : vendorId;
    if (use.selling) patch.selling_price = { mode: selling.mode, value: Number(selling.value) };
    if (use.cost) patch.cost_price = { mode: cost.mode, value: Number(cost.value) };

    const parsed = batchUpdateSchema.safeParse({ ids: selectedIds, patch });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查輸入的內容");
      return;
    }

    setSaving(true);
    try {
      const { batchUpdateProducts } = await import("@/lib/admin/fns/inv-products");
      const result = await batchUpdateProducts({ data: parsed.data });
      toast.success(
        result.price_change_pending
          ? `已更新 ${result.updated} 件；價格變更已送出待審，核准後才生效`
          : `已更新 ${result.updated} 件`,
      );
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "批次更新失敗");
    } finally {
      setSaving(false);
    }
  }

  function priceBlock(
    key: "selling" | "cost",
    label: string,
    state: { mode: PriceMode; value: string },
    setState: (v: { mode: PriceMode; value: string }) => void,
  ) {
    return (
      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`bu-${key}`}
            checked={use[key]}
            onCheckedChange={(v) => setUse({ ...use, [key]: v === true })}
          />
          <Label htmlFor={`bu-${key}`} className="font-normal">
            {label}
          </Label>
        </div>
        {use[key] ? (
          <div className="flex gap-2">
            <Select
              value={state.mode}
              onValueChange={(v) => setState({ ...state, mode: v as PriceMode })}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MODE_LABELS) as PriceMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              step="0.01"
              value={state.value}
              placeholder={state.mode === "percent" ? "例如 -10 代表打九折" : "數值"}
              onChange={(e) => setState({ ...state, value: e.target.value })}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">批次更新 {selectedIds.length} 件商品</DialogTitle>
          <DialogDescription>
            只有勾起來的欄位會被改。
            {priceApprovalOn
              ? "價格變更會送出待審 —— 一次改幾百件更需要有人看過。"
              : "調價審核目前是關閉的，價格會直接生效。"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="bu-category"
                checked={use.category}
                onCheckedChange={(v) => setUse({ ...use, category: v === true })}
              />
              <Label htmlFor="bu-category" className="font-normal">
                更新分類
              </Label>
            </div>
            {use.category ? (
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>清除分類</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.category_id} value={c.category_id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="bu-type"
                checked={use.type}
                onCheckedChange={(v) => setUse({ ...use, type: v === true })}
              />
              <Label htmlFor="bu-type" className="font-normal">
                更新商品類型
              </Label>
            </div>
            {use.type ? (
              <Select
                value={productType}
                onValueChange={(v) => setProductType(v as (typeof INV_PRODUCT_TYPES)[number])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INV_PRODUCT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {INV_PRODUCT_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="bu-vendor"
                checked={use.vendor}
                onCheckedChange={(v) => setUse({ ...use, vendor: v === true })}
              />
              <Label htmlFor="bu-vendor" className="font-normal">
                更新供應商
              </Label>
            </div>
            {use.vendor ? (
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>清除供應商</SelectItem>
                  {vendors.map((v) => (
                    <SelectItem key={v.vendor_id} value={v.vendor_id}>
                      {v.short_name || v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          {priceBlock("selling", "更新售價", selling, setSelling)}
          {priceBlock("cost", "更新成本", cost, setCost)}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving || !anySelected}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            套用到 {selectedIds.length} 件
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
