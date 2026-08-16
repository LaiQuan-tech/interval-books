/**
 * 批次更新選取的進貨 —— 只有供應商與效期兩組。
 *
 * ⚠️ 「沒勾」與「勾了但留空」是兩件不同的事。沒勾的那一組在 patch 裡根本不會出現，
 *    而 inv_batch_update_purchases() 是用 `p_patch ? 'key'` 判斷要不要動；勾了留空
 *    就是**清掉**那個欄位。這個區別要在畫面上講出來，否則店員會以為留空等於不改。
 *
 * ⚠️ 這裡不能改數量。數量會牽動 FIFO 批次與 products.stock_quantity，一次改 200 筆
 *    沒有辦法一筆筆看清楚哪一筆被擋下來、為什麼。要改數量請一筆一筆編輯。
 */
import { useEffect, useState } from "react";
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
  VendorSelect,
  type VendorOption,
  type VendorValue,
} from "@/components/inventory/VendorSelect";
import { purchaseBatchUpdateSchema } from "@/lib/admin/schemas";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  vendors: VendorOption[];
  onDone: () => void | Promise<void>;
};

const NO_VENDOR: VendorValue = { vendor_id: null, vendor: null };

export function PurchaseBatchUpdateDialog({
  open,
  onOpenChange,
  selectedIds,
  vendors,
  onDone,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [use, setUse] = useState({ vendor: false, expiry: false });
  const [vendor, setVendor] = useState<VendorValue>(NO_VENDOR);
  const [expiryDate, setExpiryDate] = useState("");
  const [alertDays, setAlertDays] = useState("7");

  // 每次打開都重置。留著上一次的選擇，下一批貨會被套上不相干的供應商。
  useEffect(() => {
    if (!open) return;
    setUse({ vendor: false, expiry: false });
    setVendor(NO_VENDOR);
    setExpiryDate("");
    setAlertDays("7");
  }, [open]);

  const anySelected = use.vendor || use.expiry;

  async function submit() {
    const patch: Record<string, unknown> = {};
    if (use.vendor) {
      patch.vendor = {
        vendor_id: vendor.vendor_id,
        vendor: vendor.vendor?.trim() || null,
      };
    }
    if (use.expiry) {
      patch.expiry = {
        expiry_date: expiryDate || null,
        // 沒有效期就沒有警示天數可言 —— 一起清掉，不要留一個指向不存在日期的天數。
        expiry_alert_days: expiryDate ? Number(alertDays || 7) : null,
      };
    }

    const parsed = purchaseBatchUpdateSchema.safeParse({ ids: selectedIds, patch });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查輸入的內容");
      return;
    }

    setSaving(true);
    try {
      const { batchUpdatePurchases } = await import("@/lib/admin/fns/inv-purchases");
      const result = await batchUpdatePurchases({ data: parsed.data });
      toast.success(`已更新 ${result.updated} 筆進貨`);
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "批次更新失敗");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">批次更新 {selectedIds.length} 筆進貨</DialogTitle>
          <DialogDescription>
            只有勾起來的那一組會被改。勾起來但留空 = 清掉那個欄位；沒勾 = 完全不動。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="pbu-vendor"
                checked={use.vendor}
                disabled={saving}
                onCheckedChange={(v) => setUse({ ...use, vendor: v === true })}
              />
              <Label htmlFor="pbu-vendor" className="font-normal">
                更新供應商
              </Label>
            </div>
            {use.vendor ? (
              <div className="space-y-2 pl-6">
                <VendorSelect
                  value={vendor}
                  onChange={setVendor}
                  vendors={vendors}
                  disabled={saving}
                  idPrefix="pbu-vendor-select"
                  label="套用的供應商"
                />
                <p className="text-xs text-muted-foreground">
                  選「不指定」= 把這幾筆的供應商清掉。
                </p>
              </div>
            ) : null}
          </div>

          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="pbu-expiry"
                checked={use.expiry}
                disabled={saving}
                onCheckedChange={(v) => setUse({ ...use, expiry: v === true })}
              />
              <Label htmlFor="pbu-expiry" className="font-normal">
                更新效期
              </Label>
            </div>
            {use.expiry ? (
              <div className="space-y-2 pl-6">
                <div className="space-y-1.5">
                  <Label htmlFor="pbu-expiry-date" className="text-xs">
                    保存期限
                  </Label>
                  <Input
                    id="pbu-expiry-date"
                    type="date"
                    value={expiryDate}
                    disabled={saving}
                    onChange={(e) => setExpiryDate(e.target.value)}
                  />
                </div>
                {expiryDate ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="pbu-alert" className="text-xs">
                      效期警示天數
                    </Label>
                    <Input
                      id="pbu-alert"
                      type="number"
                      min={1}
                      max={365}
                      value={alertDays}
                      disabled={saving}
                      onChange={(e) => setAlertDays(e.target.value)}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    留空日期 = 把這幾筆的效期與警示天數一起清掉。
                  </p>
                )}
              </div>
            ) : null}
          </div>

          {anySelected ? null : (
            <p className="py-2 text-center text-sm text-muted-foreground">
              請至少勾選一組要更新的欄位
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving || !anySelected}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            套用到 {selectedIds.length} 筆
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
