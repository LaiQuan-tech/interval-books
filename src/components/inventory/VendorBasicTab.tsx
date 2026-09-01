/**
 * 廠商表單分頁一：基本／識別。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。四個分頁的分法是
 * **依誰會來填**：門市建檔的人填這一頁，採購填第二頁，會計填第三頁，簽約的人填第四頁。
 *
 * ⚠️ 識別碼那一區在 VendorIdentitySection —— 那幾格改一次就會覆寫資料庫裡的 PII，與
 *    這裡的一般欄位不是同一種東西。
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
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { VendorIdentitySection } from "@/components/inventory/VendorIdentitySection";
import {
  NONE,
  type EntityType,
  type SensitiveKey,
  type VendorStatus,
} from "@/components/inventory/VendorFieldLabels";
import type { FormState } from "@/components/inventory/VendorFormState";
import {
  VENDOR_ENTITY_TYPES,
  VENDOR_ENTITY_TYPE_LABELS,
  VENDOR_STATUSES,
  VENDOR_STATUS_LABELS,
} from "@/lib/admin/schemas";
import type { AdminVendorRow, VendorCategoryRow } from "@/server/repos/inv-vendors";
import type { Dispatch, SetStateAction } from "react";

type Props = {
  form: FormState;
  busy: boolean;
  /** null = 新增。 */
  editing: AdminVendorRow | null;
  categories: VendorCategoryRow[];
  masks: Record<SensitiveKey, string | null>;
  changing: Record<SensitiveKey, boolean>;
  onPatch: (next: Partial<FormState>) => void;
  setChanging: Dispatch<SetStateAction<Record<SensitiveKey, boolean>>>;
};

export function VendorBasicTab({
  form,
  busy,
  editing,
  categories,
  masks,
  changing,
  onPatch,
  setChanging,
}: Props) {
  const entity = form.entity_type;

  return (
    <TabsContent value="basic" className="space-y-4 pt-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="vendor-entity">實體類型</Label>
          <Select
            value={entity}
            disabled={busy}
            onValueChange={(v) => onPatch({ entity_type: v as EntityType })}
          >
            <SelectTrigger id="vendor-entity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VENDOR_ENTITY_TYPES.map((code) => (
                <SelectItem key={code} value={code}>
                  {VENDOR_ENTITY_TYPE_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            決定下面哪一個識別碼是必填的（資料庫也會再擋一次）。
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-category">廠商類別</Label>
          <Select
            value={form.category_id ?? NONE}
            disabled={busy}
            onValueChange={(v) => onPatch({ category_id: v === NONE ? null : v })}
          >
            <SelectTrigger id="vendor-category">
              <SelectValue placeholder="未分類" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>未分類</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.category_id} value={c.category_id}>
                  {c.name}
                  {c.is_active ? "" : "（已停用）"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-name">
            供應商名稱<span className="ml-1 text-destructive">*</span>
          </Label>
          <Input
            id="vendor-name"
            value={form.name}
            disabled={busy}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-name-en">英文名稱</Label>
          <Input
            id="vendor-name-en"
            value={form.name_en}
            disabled={busy}
            onChange={(e) => onPatch({ name_en: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-short">簡稱</Label>
          <Input
            id="vendor-short"
            placeholder="單據上顯示的短名"
            value={form.short_name}
            disabled={busy}
            onChange={(e) => onPatch({ short_name: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-rep">負責人／代表人</Label>
          <Input
            id="vendor-rep"
            value={form.representative}
            disabled={busy}
            onChange={(e) => onPatch({ representative: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-status">往來狀態</Label>
          <Select
            value={form.status}
            disabled={busy}
            onValueChange={(v) => onPatch({ status: v as VendorStatus })}
          >
            <SelectTrigger id="vendor-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VENDOR_STATUSES.map((code) => (
                <SelectItem key={code} value={code}>
                  {VENDOR_STATUS_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            解約請把這裡改成「已終止」，不要刪廠商 —— 帳與貨的歷史要留著。
          </p>
        </div>

        <div className="flex items-center gap-2 self-end rounded-md border border-border p-3">
          <Switch
            id="vendor-preferred"
            checked={form.is_preferred}
            disabled={busy}
            onCheckedChange={(v) => onPatch({ is_preferred: v })}
          />
          <Label htmlFor="vendor-preferred" className="cursor-pointer">
            優先供應商
          </Label>
        </div>
      </div>

      <Separator />

      <VendorIdentitySection
        editing={editing}
        entity={entity}
        form={form}
        busy={busy}
        masks={masks}
        changing={changing}
        onPatch={onPatch}
        setChanging={setChanging}
      />

      <div className="space-y-1.5">
        <Label htmlFor="vendor-notes">備註</Label>
        <Textarea
          id="vendor-notes"
          rows={3}
          value={form.notes}
          disabled={busy}
          onChange={(e) => onPatch({ notes: e.target.value })}
        />
      </div>
    </TabsContent>
  );
}
