/**
 * 聯絡人子表的編輯表單（新增與編輯共用同一張）。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。清單那半邊管的是
 * 「有哪幾位、要刪哪一位」，這半邊管的是「一位聯絡人有哪些欄位」。
 *
 * ⚠️ 這張表單由 VendorContactSection 用 `{draft ? … : null}` 掛上去 —— 沒有草稿的時候
 *    它整個不存在，不是自己回 null。
 */
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ContactDraft } from "@/components/inventory/VendorChildDrafts";

type Props = {
  draft: ContactDraft;
  busy: boolean;
  onChange: (next: ContactDraft) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function VendorContactForm({ draft, busy, onChange, onCancel, onSave }: Props) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="contact-name">姓名</Label>
          <Input
            id="contact-name"
            value={draft.name}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-title">職稱</Label>
          <Input
            id="contact-title"
            value={draft.job_title}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, job_title: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-phone">電話</Label>
          <Input
            id="contact-phone"
            value={draft.phone}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, phone: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-mobile">手機</Label>
          <Input
            id="contact-mobile"
            value={draft.mobile}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, mobile: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-email">電子郵件</Label>
          <Input
            id="contact-email"
            type="email"
            value={draft.email}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, email: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="contact-sort">排序</Label>
          <Input
            id="contact-sort"
            type="number"
            min={0}
            max={999}
            value={draft.sort_order}
            disabled={busy}
            onChange={(e) => onChange({ ...draft, sort_order: e.target.value })}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch
            checked={draft.is_primary}
            disabled={busy}
            onCheckedChange={(v) => onChange({ ...draft, is_primary: v })}
          />
          主要聯絡人
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch
            checked={draft.is_finance_contact}
            disabled={busy}
            onCheckedChange={(v) => onChange({ ...draft, is_finance_contact: v })}
          />
          財務聯絡人
        </label>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="contact-notes">備註</Label>
        <Textarea
          id="contact-notes"
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
          儲存聯絡人
        </Button>
      </div>
    </div>
  );
}
