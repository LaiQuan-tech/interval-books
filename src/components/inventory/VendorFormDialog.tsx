/**
 * 新增／編輯廠商 —— 四個分頁：基本／識別、聯絡、財務／寄售、附件／合約。
 *
 * inv.vendors 有四十幾欄，來源系統把它攤成十個分頁，於是「一家新廠商要填什麼」沒有人
 * 答得出來。這裡收斂成四個，分法是**依誰會來填**：門市建檔的人填第一頁，採購填第二頁，
 * 會計填第三頁，簽約的人填第四頁。同一個人不需要一次走完四頁。
 *
 * 這個檔案只剩四頁共用的殼（原本 2,353 行，而元件檔的上限是 300）：表單狀態、開啟時
 * 重抓、識別碼的遮罩與鎖（lockedKeys）、儲存，以及 Dialog 與 Tabs 的骨架。四頁在
 * VendorBasicTab / VendorContactTab / VendorFinanceTab / VendorAttachmentSection，
 * 狀態與換形狀在 VendorFormState / VendorFormParsers，中文標籤在 VendorFieldLabels。
 *
 * ⚠️ **遮罩值絕對不可以當成輸入框的預設值**（見 VendorIdentityField）。由此推出一件
 *    使用者一定會問的事：**編輯既有廠商時，識別碼必須重新輸入**，不然儲存會被下面的
 *    lockedKeys 擋下來。
 *
 * ⚠️ **子表要先有廠商才能存。** 聯絡人／匯款帳戶／附件都是掛在 vendor_id 底下的獨立
 *    RPC，新增模式下還沒有 id，所以那三區會顯示「先儲存基本資料」。這比先在前端存一份
 *    草稿再一次送出好：草稿送出到一半失敗的話，使用者看不出來哪幾筆存進去了。
 *
 * ⚠️ payload 裡**沒有** approval_status / approved_by / created_by / vendor_code。四個
 *    都由資料庫決定（0019 §5.1）。來源系統是在瀏覽器算完 approval_status 再連同 insert
 *    送出去，於是「要不要審核」變成前端說了算。見 toVendorPayload。
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VendorAttachmentSection } from "@/components/inventory/VendorAttachmentSection";
import { VendorBasicTab } from "@/components/inventory/VendorBasicTab";
import { VendorContactTab } from "@/components/inventory/VendorContactTab";
import { VendorFinanceTab } from "@/components/inventory/VendorFinanceTab";
import { VendorFormHeader } from "@/components/inventory/VendorFormHeader";
import {
  SENSITIVE_KEYS,
  SENSITIVE_LABELS,
  type SensitiveKey,
} from "@/components/inventory/VendorFieldLabels";
import {
  EMPTY_FORM,
  formFromDetail,
  toVendorPayload,
  type FormState,
} from "@/components/inventory/VendorFormState";
import { vendorSchema } from "@/lib/admin/schemas";
import type {
  AdminVendorAttachment,
  AdminVendorBankAccount,
  AdminVendorContact,
  AdminVendorDetail,
  AdminVendorRow,
  TaxTypeRow,
  VendorCategoryRow,
  WithholdingRow,
} from "@/server/repos/inv-vendors";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  approvalOn: boolean;
  /** null = 新增。 */
  editing: AdminVendorRow | null;
  categories: VendorCategoryRow[];
  taxTypes: TaxTypeRow[];
  withholdingCategories: WithholdingRow[];
  onSaved: () => Promise<void>;
};

export function VendorFormDialog({
  open,
  onOpenChange,
  approvalOn,
  editing,
  categories,
  taxTypes,
  withholdingCategories,
  onSaved,
}: Props) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [detail, setDetail] = useState<AdminVendorDetail | null>(null);
  const [contacts, setContacts] = useState<AdminVendorContact[]>([]);
  const [bankAccounts, setBankAccounts] = useState<AdminVendorBankAccount[]>([]);
  const [attachments, setAttachments] = useState<AdminVendorAttachment[]>([]);
  const [changing, setChanging] = useState<Record<SensitiveKey, boolean>>({
    tax_id: false,
    id_number: false,
    foreign_id: false,
    residence_permit_number: false,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("basic");

  const vendorId = editing?.vendor_id ?? null;

  function patch(next: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...next }));
  }

  /** 重抓子表。子表是各自的 RPC 寫的，寫完只重抓不猜結果。 */
  const reloadChildren = useCallback(async () => {
    if (!vendorId) return;
    const { getAdminVendor } = await import("@/lib/admin/fns/inv-vendors");
    const result = await getAdminVendor({ data: { vendorId } });
    if (result.vendor) setDetail(result.vendor);
    setContacts(result.contacts);
    setBankAccounts(result.bankAccounts);
    setAttachments(result.attachments);
  }, [vendorId]);

  // 開啟時重置。編輯的話重抓一次 detail —— 清單那份沒有第三、四頁要的欄位，
  // 而且重抓才看得到別人五分鐘前改掉的內容。
  useEffect(() => {
    if (!open) return;
    setTab("basic");
    setForm(EMPTY_FORM);
    setDetail(null);
    setContacts([]);
    setBankAccounts([]);
    setAttachments([]);
    setChanging({
      tax_id: false,
      id_number: false,
      foreign_id: false,
      residence_permit_number: false,
    });
    if (!vendorId) return;

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { getAdminVendor } = await import("@/lib/admin/fns/inv-vendors");
        const result = await getAdminVendor({ data: { vendorId } });
        if (cancelled) return;
        if (result.vendor) {
          setDetail(result.vendor);
          setForm(formFromDetail(result.vendor));
        }
        setContacts(result.contacts);
        setBankAccounts(result.bankAccounts);
        setAttachments(result.attachments);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "廠商資料讀取失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, vendorId]);

  const masks: Record<SensitiveKey, string | null> = {
    tax_id: detail?.tax_id_masked ?? null,
    id_number: detail?.id_number_masked ?? null,
    foreign_id: detail?.foreign_id_masked ?? null,
    residence_permit_number: detail?.residence_permit_number_masked ?? null,
  };

  /** 還沒按「更改」、卻已經有值的識別碼。有任何一個就不讓存 —— 理由見檔頭第 1 點。 */
  const lockedKeys = SENSITIVE_KEYS.filter((key) => masks[key] !== null && !changing[key]);

  async function save() {
    if (lockedKeys.length > 0) {
      toast.error(
        `請先按「更改」重新輸入完整的${lockedKeys.map((k) => SENSITIVE_LABELS[k]).join("、")}` +
          "（系統讀不回原值，儲存會直接覆寫資料庫）",
      );
      setTab("basic");
      return;
    }

    const parsed = vendorSchema.safeParse(toVendorPayload(form, vendorId));

    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查填寫的內容");
      return;
    }

    setSaving(true);
    try {
      const { saveVendor } = await import("@/lib/admin/fns/inv-vendors");
      const result = await saveVendor({ data: parsed.data });
      toast.success(
        result.approval_status === "approved"
          ? `「${parsed.data.name}」已儲存（${result.vendor_code}）`
          : `「${parsed.data.name}」已儲存待審核（${result.vendor_code}），核准後才能開始往來`,
      );
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "廠商儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || loading;

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <VendorFormHeader editing={editing} approvalOn={approvalOn} />

        {loading ? (
          <div className="flex h-40 items-center justify-center rounded-md border border-border">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex w-full flex-wrap">
              <TabsTrigger value="basic">基本／識別</TabsTrigger>
              <TabsTrigger value="contact">聯絡</TabsTrigger>
              <TabsTrigger value="finance">財務／寄售</TabsTrigger>
              <TabsTrigger value="files">附件／合約</TabsTrigger>
            </TabsList>

            <VendorBasicTab
              form={form}
              busy={busy}
              editing={editing}
              categories={categories}
              masks={masks}
              changing={changing}
              onPatch={patch}
              setChanging={setChanging}
            />

            <VendorContactTab
              form={form}
              busy={busy}
              vendorId={vendorId}
              contacts={contacts}
              onPatch={patch}
              onReload={reloadChildren}
            />

            <VendorFinanceTab
              form={form}
              busy={busy}
              taxTypes={taxTypes}
              withholdingCategories={withholdingCategories}
              vendorId={vendorId}
              bankAccounts={bankAccounts}
              onPatch={patch}
              onReload={reloadChildren}
            />

            <TabsContent value="files" className="space-y-4 pt-4">
              <VendorAttachmentSection
                vendorId={vendorId}
                rows={attachments}
                disabled={busy}
                onReload={reloadChildren}
              />
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button className="gap-1.5" disabled={busy} onClick={() => void save()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            儲存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
