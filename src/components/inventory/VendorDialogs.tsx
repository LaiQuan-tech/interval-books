/**
 * 廠商這一頁的兩個對話框 + 一個二次確認。
 *
 * 全部收在一起，理由與 ComboSetDialogs.tsx / AdjustmentDialogs.tsx 相同：它們對
 * route 來說是同一件事「某個 state 不是 null 的時候蓋一層東西上去」。留在 route 檔
 * 只會把真正的版面（標題列、送審佇列、篩選、表格）推到 300 行以外。
 *
 * ⚠️ **刪除的對話框要把話講完。** inv_delete_vendor() 會在還有商品／進貨／退貨單／
 *    入口帳號的時候擋下來，並回一句「解約請把往來狀態改成『已終止』」。這裡把同一件
 *    事先講在前面，而且把那四個數字印出來 —— 「按了才知道不行」是最差的順序，尤其
 *    當正確做法（改往來狀態）根本不在同一個按鈕底下的時候。
 *
 * ⚠️ 詳情是唯讀的，而且**識別碼與匯款帳號永遠是遮罩**。完整號碼只有
 *    VendorSensitiveDialog 那一條路，而那一條路會留下 pii_access_log。這裡不放
 *    「顯示完整號碼」的捷徑 —— 稽核軌跡只要有一條旁路就等於沒有。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { VendorFormDialog } from "@/components/inventory/VendorFormDialog";
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
  TaxTypeRow,
  VendorCategoryRow,
  WithholdingRow,
} from "@/server/repos/inv-vendors";

type Props = {
  approvalOn: boolean;
  categories: VendorCategoryRow[];
  taxTypes: TaxTypeRow[];
  withholdingCategories: WithholdingRow[];
  refresh: () => Promise<void>;

  formOpen: boolean;
  setFormOpen: (v: boolean) => void;
  /** null = 新增。 */
  editing: AdminVendorRow | null;

  detail: AdminVendorRow | null;
  setDetail: (v: AdminVendorRow | null) => void;

  deleting: AdminVendorRow | null;
  setDeleting: (v: AdminVendorRow | null) => void;
  onConfirmDelete: (row: AdminVendorRow) => void;
};

export function VendorDialogs({
  approvalOn,
  categories,
  taxTypes,
  withholdingCategories,
  refresh,
  formOpen,
  setFormOpen,
  editing,
  detail,
  setDetail,
  deleting,
  setDeleting,
  onConfirmDelete,
}: Props) {
  const linkedCount =
    (deleting?.product_count ?? 0) +
    (deleting?.purchase_count ?? 0) +
    (deleting?.portal_account_count ?? 0);

  return (
    <>
      <VendorFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        approvalOn={approvalOn}
        editing={editing}
        categories={categories}
        taxTypes={taxTypes}
        withholdingCategories={withholdingCategories}
        onSaved={refresh}
      />

      <VendorDetailDialog
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        row={detail}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              刪除廠商「{deleting?.name}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              這個動作無法復原。
              {linkedCount > 0 ? (
                <>
                  <strong>
                    這家還有 {deleting?.product_count ?? 0} 件商品、
                    {deleting?.purchase_count ?? 0} 筆進貨、
                    {deleting?.portal_account_count ?? 0} 個自助入口帳號
                  </strong>
                  ，資料庫會擋下來 —— 帳與貨的歷史要留著，不能因為刪一筆主檔就變成孤兒。
                  不再往來請改成「編輯 → 往來狀態 → 已終止」，那才是解約的做法。
                </>
              ) : (
                "只有完全沒有往來資料（商品、進貨、退貨單、自助入口帳號）的廠商刪得掉。有任何一種，資料庫都會擋下來並告訴你各有幾筆 —— 那種情況請把往來狀態改成「已終止」。"
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const pending = deleting;
                setDeleting(null);
                if (pending) onConfirmDelete(pending);
              }}
            >
              確認刪除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// 詳情（唯讀）
// ---------------------------------------------------------------------------

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
function VendorDetailDialog({
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

            <div className="space-y-2">
              <p className="text-sm font-medium">聯絡人（{contacts.length}）</p>
              {contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">沒有聯絡人。</p>
              ) : (
                <ul className="space-y-1">
                  {contacts.map((c) => (
                    <li key={c.contact_id} className="text-sm">
                      {c.name}
                      {c.job_title ? `（${c.job_title}）` : ""}
                      <span className="text-muted-foreground">
                        {" "}
                        {[c.phone, c.mobile, c.email].filter(Boolean).join("・")}
                      </span>
                      {c.is_primary ? (
                        <Badge variant="secondary" className="ml-1.5 font-normal">
                          主要
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">匯款帳戶（{bankAccounts.length}）</p>
              {bankAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">沒有匯款帳戶。</p>
              ) : (
                <ul className="space-y-1">
                  {bankAccounts.map((b) => (
                    <li key={b.bank_account_id} className="text-sm">
                      {b.account_holder_name}・{b.bank_code} {b.bank_name}
                      {/* ⚠️ 遮罩。view 沒有把完整帳號送出來，這裡也不該有捷徑。 */}
                      <span className="ml-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                        {b.account_number_masked ?? "—"}
                      </span>
                      {b.is_default ? (
                        <Badge variant="secondary" className="ml-1.5 font-normal">
                          預設
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">附件（{attachments.length}）</p>
              {attachments.length === 0 ? (
                <p className="text-sm text-muted-foreground">沒有附件。</p>
              ) : (
                <ul className="space-y-1">
                  {attachments.map((a) => (
                    <li key={a.attachment_id} className="text-sm">
                      {a.file_name}
                      {a.attachment_type === "contract" ? (
                        <span className="text-muted-foreground">
                          （合約 {a.contract_start_date ?? "—"} ~ {a.contract_end_date ?? "—"}）
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                要開檔案請到「編輯 → 附件／合約」，那裡才會去簽一組短效網址（私有 bucket
                沒有永久網址）。
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">讀不到這家廠商的詳細資料。</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
