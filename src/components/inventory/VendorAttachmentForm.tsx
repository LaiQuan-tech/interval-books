/**
 * 附件／合約的上傳表單。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。
 *
 * ⚠️ 流程是 **先填完再上傳**：選檔案只是記在 state 裡，按下「上傳並儲存」才真的送出。
 *    反過來（選完就上傳）的話，使用者中途放棄會在 storage 留下一個沒有人指得到的孤兒
 *    檔案。真正的上傳在 VendorAttachmentSection 的 upload()。
 *
 * ⚠️ setDraft 是**原封不動**傳進來的 useState setter：檔案那一格用的是 updater 形式
 *    （要讀 prev.file_name 才知道要不要把檔名帶進來），換成 (next) => void 會壞掉。
 */
import { Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  ATTACHMENT_TYPE_LABELS,
  type AttachmentType,
} from "@/components/inventory/VendorFieldLabels";
import type { AttachmentDraft } from "@/components/inventory/VendorChildDrafts";
import { VENDOR_ATTACHMENT_TYPES } from "@/lib/admin/schemas";
import type { Dispatch, RefObject, SetStateAction } from "react";

type Props = {
  draft: AttachmentDraft;
  setDraft: Dispatch<SetStateAction<AttachmentDraft>>;
  busy: boolean;
  disabled: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onUpload: () => void;
};

export function VendorAttachmentForm({
  draft,
  setDraft,
  busy,
  disabled,
  fileInputRef,
  onUpload,
}: Props) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">新增附件</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="attachment-file">檔案（PDF／JPEG／PNG／WebP，上限 20MB）</Label>
          <Input
            id="attachment-file"
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              setDraft((prev) => ({
                ...prev,
                file,
                // 檔名先帶進來當顯示名稱，使用者可以改成看得懂的名字。
                file_name: prev.file_name === "" && file ? file.name : prev.file_name,
              }));
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="attachment-name">顯示名稱</Label>
          <Input
            id="attachment-name"
            value={draft.file_name}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, file_name: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="attachment-type">類型</Label>
          <Select
            value={draft.attachment_type}
            disabled={busy}
            onValueChange={(v) => setDraft({ ...draft, attachment_type: v as AttachmentType })}
          >
            <SelectTrigger id="attachment-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VENDOR_ATTACHMENT_TYPES.map((code) => (
                <SelectItem key={code} value={code}>
                  {ATTACHMENT_TYPE_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {draft.attachment_type === "contract" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="attachment-start">合約起日</Label>
              <Input
                id="attachment-start"
                type="date"
                value={draft.contract_start_date}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, contract_start_date: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="attachment-end">合約迄日</Label>
              <Input
                id="attachment-end"
                type="date"
                value={draft.contract_end_date}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, contract_end_date: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="attachment-version">合約版本</Label>
              <Input
                id="attachment-version"
                placeholder="例：2026 年版"
                value={draft.contract_version}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, contract_version: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2 self-end rounded-md border border-border p-3">
              <Switch
                id="attachment-current"
                checked={draft.is_current}
                disabled={busy}
                onCheckedChange={(v) => setDraft({ ...draft, is_current: v })}
              />
              <Label htmlFor="attachment-current" className="cursor-pointer">
                現行版本
              </Label>
            </div>
          </>
        ) : null}

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="attachment-desc">說明</Label>
          <Input
            id="attachment-desc"
            value={draft.description}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          className="gap-1.5"
          disabled={disabled || busy || draft.file === null}
          onClick={onUpload}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Paperclip className="h-3.5 w-3.5" />
          )}
          上傳並儲存
        </Button>
      </div>
    </div>
  );
}
