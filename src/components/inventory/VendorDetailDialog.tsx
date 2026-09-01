/**
 * 廠商詳情（唯讀）。
 *
 * 從 VendorDialogs 抽出來：那個檔案的職責是「route 的某個 state 不是 null 就蓋一層
 * 東西上去」，詳情本身則是一個會自己重抓資料的元件，兩件事混在一起會讓那個檔案
 * 越長越大（原本 409 行，而元件檔的上限是 300）。
 *
 * ⚠️ 這裡的識別碼與匯款帳號**永遠是遮罩**。完整號碼只有 VendorSensitiveDialog 那一條
 *    路，而那一條路會留下 pii_access_log。這裡不放「顯示完整號碼」的捷徑 —— 稽核軌跡
 *    只要有一條旁路就等於沒有。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ApprovalStatusBadge } from "@/components/inventory/ApprovalStatusBadge";
import { VendorDetailChildLists } from "@/components/inventory/VendorDetailChildLists";
import {
  VENDOR_ENTITY_TYPES,
  VENDOR_ENTITY_TYPE_LABELS,
  VENDOR_STATUSES,
  VENDOR_STATUS_LABELS,
} from "@/lib/admin/schemas";
import type {
  AdminVendorAttachment,
  AdminVendorBankAccount,
  AdminVendorContact,
  AdminVendorDetail,
  AdminVendorRow,
} from "@/server/repos/inv-vendors";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) : "—";
}

/** 0–1 小數 → 百分比字串。toFixed 是為了躲 0.1115 × 100 = 11.150000000000002。 */
function percent(rate: number | null): string {
  if (rate === null) return "—";
  return `${Number((rate * 100).toFixed(2))}%`;
}

function label<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
  value: string | null,
): string {
  if (value === null) return "—";
  const found = values.find((v) => v === value);
  // 認不出來就原樣印出去（與 ApprovalStatusBadge 同一條規矩）。
  return found ? labels[found] : value;
}

/**
 * 廠商詳情。
 *
 * ⚠️ 開啟時**重抓一次**（getAdminVendor），不吃清單頁那份 —— 詳情是拿來做決定的
 *    地方（要不要核准、要不要匯款），看到別人五分鐘前改掉的內容比少一次請求重要。
 *    順便一次把三張子表也帶回來，因為 server fn 本來就是四個一起 Promise.all。
 */
export function VendorDetailDialog({
  open,
  onOpenChange,
  row,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: AdminVendorRow | null;
}) {
  const [detail, setDetail] = useState<AdminVendorDetail | null>(null);
  const [contacts, setContacts] = useState<AdminVendorContact[]>([]);
  const [bankAccounts, setBankAccounts] = useState<AdminVendorBankAccount[]>([]);
  const [attachments, setAttachments] = useState<AdminVendorAttachment[]>([]);
  const [loading, setLoading] = useState(false);

  const vendorId = row?.vendor_id ?? null;

  useEffect(() => {
    if (!open || !vendorId) return;
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setContacts([]);
    setBankAccounts([]);
    setAttachments([]);
    void (async () => {
      try {
        const { getAdminVendor } = await import("@/lib/admin/fns/inv-vendors");
        const result = await getAdminVendor({ data: { vendorId } });
        if (cancelled) return;
        setDetail(result.vendor);
        setContacts(result.contacts);
        setBankAccounts(result.bankAccounts);
        setAttachments(result.attachments);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "廠商詳情讀取失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, vendorId]);

  if (!row) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{row.name}</DialogTitle>
          <DialogDescription>
            {row.vendor_code ?? "（未編號）"}
            {row.short_name ? `・${row.short_name}` : ""}
            {row.category_name ? `・${row.category_name}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-normal">
            {label(VENDOR_ENTITY_TYPES, VENDOR_ENTITY_TYPE_LABELS, row.entity_type)}
          </Badge>
          <Badge variant={row.status === "active" ? "default" : "outline"} className="font-normal">
            {label(VENDOR_STATUSES, VENDOR_STATUS_LABELS, row.status)}
          </Badge>
          <ApprovalStatusBadge status={row.approval_status} />
          <Badge variant={row.is_consignment ? "default" : "outline"} className="font-normal">
            {row.is_consignment ? "寄售" : "買斷"}
          </Badge>
        </div>

        {loading ? (
          <div className="flex h-40 items-center justify-center rounded-md border border-border">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="英文名稱">{detail.name_en ?? "—"}</Field>
              <Field label="負責人">{detail.representative ?? "—"}</Field>
              <Field label="建立者">{detail.creator_name ?? "—"}</Field>
              {/* ⚠️ 全部是遮罩。完整號碼走清單上的「完整號碼」按鈕，那會留下紀錄。 */}
              <Field label="統一編號">{detail.tax_id_masked ?? "—"}</Field>
              <Field label="身分證字號">{detail.id_number_masked ?? "—"}</Field>
              <Field label="國外識別碼">{detail.foreign_id_masked ?? "—"}</Field>
              <Field label="居留證號碼">{detail.residence_permit_number_masked ?? "—"}</Field>
              <Field label="審核者">{detail.approved_by_name ?? "—"}</Field>
              <Field label="審核時間">{when(detail.approved_at)}</Field>
            </div>

            <Separator />

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="電話">{detail.phone ?? "—"}</Field>
              <Field label="傳真">{detail.fax ?? "—"}</Field>
              <Field label="電子郵件">{detail.email ?? "—"}</Field>
              <Field label="地址">{detail.address ?? "—"}</Field>
              <Field label="發票寄送地址">{detail.invoice_address ?? "—"}</Field>
              <Field label="英文地址">{detail.address_en ?? "—"}</Field>
            </div>

            <Separator />

            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="現金手續費">{percent(detail.cash_fee_rate)}</Field>
              <Field label="國內刷卡">{percent(detail.domestic_card_fee_rate)}</Field>
              <Field label="國外刷卡">{percent(detail.foreign_card_fee_rate)}</Field>
              <Field label="寄售抽成">{percent(detail.commission_rate)}</Field>
              <Field label="結算起算日">{detail.settlement_start_day ?? "—"}</Field>
              <Field label="結算週期">
                {detail.settlement_interval_days === null
                  ? "—"
                  : `${detail.settlement_interval_days} 天`}
              </Field>
              <Field label="請款截止日">{detail.bill_due_day ?? "—"}</Field>
              <Field label="二代健保">{detail.is_nhi_applicable ? "需扣繳" : "不需"}</Field>
            </div>

            <Separator />

            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="商品數">{row.product_count}</Field>
              <Field label="進貨筆數">{row.purchase_count}</Field>
              <Field label="自助入口帳號">{row.portal_account_count}</Field>
              <Field label="庫存件數">{row.stock_units}</Field>
            </div>

            <Separator />

            <VendorDetailChildLists
              contacts={contacts}
              bankAccounts={bankAccounts}
              attachments={attachments}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">讀不到這家廠商的詳細資料。</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
