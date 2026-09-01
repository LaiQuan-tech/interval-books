/**
 * 匯款帳戶子表的編輯表單（新增與編輯共用同一張）。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。
 *
 * ⚠️ 帳號用的是與識別碼同一顆 IdentityField：有遮罩就先顯示遮罩 + 一顆「更改」，按下去
 *    才變成輸入框。理由見 VendorIdentityField 的檔頭 —— 把遮罩存回去等於毀掉那個帳號。
 *
 * ⚠️ 這張表單由 VendorBankSection 用 `{draft ? … : null}` 掛上去 —— 沒有草稿的時候它整個
 *    不存在，不是自己回 null。
 */
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { IdentityField } from "@/components/inventory/VendorIdentityField";
import type { BankDraft } from "@/components/inventory/VendorChildDrafts";

type Props = {
  draft: BankDraft;
  busy: boolean;
  onChange: (next: BankDraft) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function VendorBankForm({ draft, busy, onChange, onCancel, onSave }: Props) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bank-holder">戶名</Label>
          <Input
            id="bank-holder"
            value={draft.account_holder_name}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, account_holder_name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bank-purpose">用途</Label>
          <Input
            id="bank-purpose"
            placeholder="例：貨款、版稅"
            value={draft.account_purpose}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, account_purpose: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bank-code">銀行代碼</Label>
          <Input
            id="bank-code"
            maxLength={5}
            value={draft.bank_code}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, bank_code: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bank-name">銀行名稱</Label>
          <Input
            id="bank-name"
            value={draft.bank_name}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, bank_name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bank-branch-code">分行代碼</Label>
          <Input
            id="bank-branch-code"
            maxLength={10}
            value={draft.branch_code}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, branch_code: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bank-branch-name">分行名稱</Label>
          <Input
            id="bank-branch-name"
            value={draft.branch_name}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, branch_name: e.target.value })}
          />
        </div>

        <div className="sm:col-span-2">
          <IdentityField
            id="bank-account-number"
            label="帳號"
            masked={draft.masked}
            changing={draft.changingNumber}
            value={draft.account_number}
            disabled={busy}
            required
            onStartChange={() => onChange({ ...draft, changingNumber: true })}
            onCancelChange={() => onChange({ ...draft, changingNumber: false, account_number: "" })}
            onChange={(v) => onChange({ ...draft, account_number: v })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="bank-sort">排序</Label>
          <Input
            id="bank-sort"
            type="number"
            min={0}
            max={999}
            value={draft.sort_order}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, sort_order: e.target.value })}
          />
        </div>

        <div className="flex items-center gap-2 self-end rounded-md border border-border p-3">
          <Switch
            id="bank-default"
            checked={draft.is_default}
            disabled={busy}
            onCheckedChange={(v) => onChange({ ...draft, is_default: v })}
          />
          <Label htmlFor="bank-default" className="cursor-pointer">
            預設匯款帳戶
          </Label>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bank-notes">備註</Label>
        <Textarea
          id="bank-notes"
          rows={2}
          value={draft.notes}
          disabled={busy}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" className="gap-1.5" disabled={busy} onClick={onSave}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          儲存帳戶
        </Button>
      </div>
    </div>
  );
}
