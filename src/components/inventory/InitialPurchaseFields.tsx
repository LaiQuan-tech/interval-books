/**
 * 新增商品時一起建立的第一筆進貨。
 *
 * 庫存不是表單上的一個數字 —— 它由 inv.purchases 的 trigger 加上去。來源系統也是
 * 這樣，差別是它送兩次 HTTP（商品一次、進貨一次），進貨失敗就留下一件永遠沒有貨
 * 的商品；這裡兩者在 inv_save_product() 的同一個交易裡。
 */
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export type InitialPurchase = {
  quantity: string;
  cost_price: string;
  vendor: string;
  purchase_date: string;
};

type Props = {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  purchase: InitialPurchase;
  onPurchaseChange: (next: InitialPurchase) => void;
};

export function InitialPurchaseFields({ enabled, onEnabledChange, purchase, onPurchaseChange }: Props) {
  return (
    <>
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="p-with-purchase"
                  checked={enabled}
                  onCheckedChange={(v) => onEnabledChange(v === true)}
                />
                <Label htmlFor="p-with-purchase" className="font-normal">
                  同時建立一筆進貨記錄
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                庫存不是直接填的數字 —— 它由進貨加上去。這一筆進貨與商品在同一個交易裡建立，
                不會出現「商品建好了、進貨沒進去」。
              </p>

              {enabled ? (
                <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="pu-qty" className="text-xs">
                      數量
                    </Label>
                    <Input
                      id="pu-qty"
                      type="number"
                      min={1}
                      value={purchase.quantity}
                      onChange={(e) => onPurchaseChange({ ...purchase, quantity: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pu-cost" className="text-xs">
                      進貨單價
                    </Label>
                    <Input
                      id="pu-cost"
                      type="number"
                      min={0}
                      step="0.01"
                      value={purchase.cost_price}
                      onChange={(e) => onPurchaseChange({ ...purchase, cost_price: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pu-vendor" className="text-xs">
                      供應商（文字）
                    </Label>
                    <Input
                      id="pu-vendor"
                      value={purchase.vendor}
                      maxLength={200}
                      onChange={(e) => onPurchaseChange({ ...purchase, vendor: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pu-date" className="text-xs">
                      進貨日期
                    </Label>
                    <Input
                      id="pu-date"
                      type="date"
                      value={purchase.purchase_date}
                      onChange={(e) => onPurchaseChange({ ...purchase, purchase_date: e.target.value })}
                    />
                  </div>
                </div>
              ) : null}
            </div>

    </>
  );
}
