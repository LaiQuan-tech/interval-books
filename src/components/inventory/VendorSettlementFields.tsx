/**
 * 財務／寄售分頁裡的付款與結算條件（付款條件、補充、結算方式、起算日、週期、請款截止日）。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。與上半段的稅別／
 * 扣繳／憑證分開，是因為那半段決定「開什麼單」，這半段決定「什麼時候付錢」。
 *
 * ⚠️ 回傳 Fragment 不是 <div>：這幾格本來就是同一個 sm:grid-cols-2 的直接子元素，包一層
 *    容器會把它們擠成一格。
 *
 * ⚠️ 三個「日」是整數欄位，送出前走 intOrNull。畫面上的 min/max 只是輸入框的提示，真正
 *    的範圍由 vendorSchema 與資料庫的 CHECK 各守一次。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PAYMENT_TERMS_LABELS,
  SETTLEMENT_LABELS,
  type PaymentTerms,
  type SettlementType,
} from "@/components/inventory/VendorFieldLabels";
import type { FormState } from "@/components/inventory/VendorFormState";
import { VENDOR_PAYMENT_TERMS, VENDOR_SETTLEMENT_TYPES } from "@/lib/admin/schemas";

type Props = {
  form: FormState;
  busy: boolean;
  onPatch: (next: Partial<FormState>) => void;
};

export function VendorSettlementFields({ form, busy, onPatch }: Props) {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="vendor-terms">付款條件</Label>
        <Select
          value={form.payment_terms}
          disabled={busy}
          onValueChange={(v) => onPatch({ payment_terms: v as PaymentTerms })}
        >
          <SelectTrigger id="vendor-terms">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VENDOR_PAYMENT_TERMS.map((code) => (
              <SelectItem key={code} value={code}>
                {PAYMENT_TERMS_LABELS[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vendor-terms-note">付款條件補充</Label>
        <Input
          id="vendor-terms-note"
          placeholder="例：出貨後 30 天"
          value={form.payment_terms_note}
          disabled={busy}
          onChange={(e) => onPatch({ payment_terms_note: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vendor-settlement">結算方式</Label>
        <Select
          value={form.settlement_type}
          disabled={busy}
          onValueChange={(v) => onPatch({ settlement_type: v as SettlementType })}
        >
          <SelectTrigger id="vendor-settlement">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VENDOR_SETTLEMENT_TYPES.map((code) => (
              <SelectItem key={code} value={code}>
                {SETTLEMENT_LABELS[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vendor-settlement-start">結算起算日（1–31）</Label>
        <Input
          id="vendor-settlement-start"
          type="number"
          min={1}
          max={31}
          value={form.settlement_start_day}
          disabled={busy}
          onChange={(e) => onPatch({ settlement_start_day: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vendor-settlement-interval">結算週期（天）</Label>
        <Input
          id="vendor-settlement-interval"
          type="number"
          min={0}
          max={365}
          value={form.settlement_interval_days}
          disabled={busy}
          onChange={(e) => onPatch({ settlement_interval_days: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vendor-bill-due">請款截止日（1–31）</Label>
        <Input
          id="vendor-bill-due"
          type="number"
          min={1}
          max={31}
          value={form.bill_due_day}
          disabled={busy}
          onChange={(e) => onPatch({ bill_due_day: e.target.value })}
        />
      </div>
    </>
  );
}
