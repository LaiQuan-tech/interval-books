/**
 * 財務／寄售分頁裡的「寄售 + 四個費率」那一段。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。
 *
 * ⚠️ 這四格填的是**百分比**，送出前 ÷100 變成 0–1 的小數（VendorFormParsers 的
 *    percentToRate）。vendorSchema 與 inv.assert_rate() 收的都是小數。
 *
 * ⚠️ 回傳的是 Fragment 不是 <div>：這幾塊本來就是 TabsContent 那個 space-y-4 容器的
 *    直接子元素，包一層容器會改掉間距。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { FormState } from "@/components/inventory/VendorFormState";

type Props = {
  form: FormState;
  busy: boolean;
  onPatch: (next: Partial<FormState>) => void;
};

export function VendorFeeRateFields({ form, busy, onPatch }: Props) {
  return (
    <>
      <Separator />

      <div className="flex items-center gap-2 rounded-md border border-border p-3">
        <Switch
          id="vendor-consignment"
          checked={form.is_consignment}
          disabled={busy}
          onCheckedChange={(v) => onPatch({ is_consignment: v })}
        />
        <Label htmlFor="vendor-consignment" className="cursor-pointer">
          寄售廠商（賣掉才結帳給對方）
        </Label>
      </div>

      {/* ⚠️ 這四格填的是**百分比**，送出前 ÷100 變成 0–1 的小數
        （percentToRate）。vendorSchema 與 inv.assert_rate() 收的都是小數。 */}
      <div className="grid gap-4 sm:grid-cols-4">
        <RateField
          id="vendor-cash-fee"
          label="現金手續費 %"
          value={form.cash_fee_rate}
          disabled={busy}
          onChange={(v) => onPatch({ cash_fee_rate: v })}
        />
        <RateField
          id="vendor-domestic-fee"
          label="國內刷卡 %"
          value={form.domestic_card_fee_rate}
          disabled={busy}
          onChange={(v) => onPatch({ domestic_card_fee_rate: v })}
        />
        <RateField
          id="vendor-foreign-fee"
          label="國外刷卡 %"
          value={form.foreign_card_fee_rate}
          disabled={busy}
          onChange={(v) => onPatch({ foreign_card_fee_rate: v })}
        />
        <RateField
          id="vendor-commission"
          label="寄售抽成 %"
          value={form.commission_rate}
          disabled={busy}
          onChange={(v) => onPatch({ commission_rate: v })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        空白代表沿用資料庫預設（現金 8%、國內刷卡 10.1%、國外刷卡 11.15%）。 抽成留空就是沒有抽成。
      </p>
    </>
  );
}

function RateField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        max={100}
        step="0.01"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
