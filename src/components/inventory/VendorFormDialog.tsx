/**
 * 新增／編輯廠商 —— 四個分頁：基本／識別、聯絡、財務／寄售、附件／合約。
 *
 * ── 這個表單在解什麼問題 ──────────────────────────────────────────────────
 * inv.vendors 有四十幾欄，來源系統把它攤成十個分頁，於是「一家新廠商要填什麼」
 * 沒有人答得出來。這裡收斂成四個，分法是**依誰會來填**：門市建檔的人填第一頁，
 * 採購填第二頁，會計填第三頁，簽約的人填第四頁。同一個人不需要一次走完四頁。
 *
 * ── 三件最容易寫錯的事 ────────────────────────────────────────────────────
 *
 * 1. **遮罩值絕對不可以當成輸入框的預設值。**
 *    編輯既有廠商時，讀回來的識別碼是 `tax_id_masked`（例如 `****5678`）——
 *    view 那一層根本沒有把完整號碼送到瀏覽器。如果把它塞進 input 的 defaultValue，
 *    使用者只要按一次儲存，`inv_save_vendor()` 的 UPDATE 就會把 `****5678` 這串字
 *    真的寫進 tax_id 欄位，而且**沒有任何一層會報錯** —— 那條 UPDATE 是直接覆寫
 *    （見 0019 SQL：`tax_id = v_tax_id`，沒有 COALESCE、沒有「key 不存在就不動」）。
 *    所以這裡的識別碼欄位在編輯模式下是**唯讀的遮罩顯示 + 一顆「更改」按鈕**，
 *    按下去才變成空白輸入框，而且要求重新輸入完整號碼。
 *
 *    ⚠️ 由此推出一件使用者一定會問的事：**編輯既有廠商時，識別碼必須重新輸入**，
 *    不然儲存會被擋下來。這不是懶得做「留空＝不變更」，而是那個做法在這個資料庫上
 *    做不出來：payload 少一個 key 會被 zod 擋（vendorSchema 的識別碼欄位是
 *    nullable 但不是 optional），送 null 會被 UPDATE 直接寫成 NULL，而
 *    domestic_company 送 null 還會撞上 `VENDOR_TAX_ID_REQUIRED`。三條路都不通，
 *    所以走第四條：講清楚，然後要求重打一次。要看原值請走「完整號碼」那扇門
 *    （VendorSensitiveDialog），那會留下一筆查閱紀錄 —— 那才是原值該有的代價。
 *
 * 2. **費率：資料庫存 0–1 的小數，畫面填百分比。**
 *    DB 的 cash_fee_rate 預設是 0.08，店員腦裡的數字是「8%」。轉換就在這個檔案裡
 *    （rateToPercent / percentToRate），vendorSchema 收的是小數，`inv.assert_rate()`
 *    也是用 0–1 檢查。兩邊各守一次，中間這一層負責翻譯。乘除 100 之後有做
 *    toFixed 收尾，因為 0.1115 × 100 在 IEEE 754 下會變成 11.150000000000002。
 *
 * 3. **子表要先有廠商才能存。** 聯絡人／匯款帳戶／附件都是掛在 vendor_id 底下的
 *    獨立 RPC，新增模式下還沒有 id，所以那三區會顯示「先儲存基本資料」。這比先在
 *    前端存一份草稿再一次送出好：草稿送出到一半失敗的話，使用者看不出來哪幾筆存
 *    進去了。
 *
 * ⚠️ payload 裡**沒有** approval_status / approved_by / created_by / vendor_code。
 *    四個都由資料庫決定（0019 §5.1）。來源系統是在瀏覽器算完 approval_status 再連同
 *    insert 送出去，於是「要不要審核」變成前端說了算。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Paperclip, Plus, Save, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  VENDOR_ATTACHMENT_TYPES,
  VENDOR_EINVOICE_TYPES,
  VENDOR_ENTITY_TYPES,
  VENDOR_ENTITY_TYPE_LABELS,
  VENDOR_PAYMENT_TERMS,
  VENDOR_RESIDENCY_STATUSES,
  VENDOR_SETTLEMENT_TYPES,
  VENDOR_STATUSES,
  VENDOR_STATUS_LABELS,
  VENDOR_VOUCHER_CATEGORIES,
  vendorAttachmentSchema,
  vendorBankAccountSchema,
  vendorContactSchema,
  vendorSchema,
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

// ---------------------------------------------------------------------------
// 值域與中文標籤
// ---------------------------------------------------------------------------
// schemas.ts 只 export 了 entity_type 與 status 的標籤（那兩個清單頁也要用），
// 下面五個是只有這張表單需要的，所以留在這裡。⚠️ 值域以 schemas.ts 的 const 陣列
// 為準，這裡只補中文 —— 少一個 key 會被 TypeScript 的 Record<> 抓出來。

type EntityType = (typeof VENDOR_ENTITY_TYPES)[number];
type VendorStatus = (typeof VENDOR_STATUSES)[number];
type VoucherCategory = (typeof VENDOR_VOUCHER_CATEGORIES)[number];
type EinvoiceType = (typeof VENDOR_EINVOICE_TYPES)[number];
type PaymentTerms = (typeof VENDOR_PAYMENT_TERMS)[number];
type SettlementType = (typeof VENDOR_SETTLEMENT_TYPES)[number];
type ResidencyStatus = (typeof VENDOR_RESIDENCY_STATUSES)[number];
type AttachmentType = (typeof VENDOR_ATTACHMENT_TYPES)[number];

const VOUCHER_LABELS: Record<VoucherCategory, string> = {
  invoice: "統一發票",
  receipt: "收據",
  official_document: "公文",
  labor_payment: "勞務報酬單",
  none: "無憑證",
};

const EINVOICE_LABELS: Record<EinvoiceType, string> = {
  none: "不開立",
  b2b: "B2B（三聯式）",
  b2c: "B2C（二聯式）",
};

const PAYMENT_TERMS_LABELS: Record<PaymentTerms, string> = {
  immediate: "即期付款",
  monthly: "月結",
  negotiated: "另行議定",
};

const SETTLEMENT_LABELS: Record<SettlementType, string> = {
  invoice_date: "依發票日結算",
  end_of_month: "月底結算",
  monthly: "月結",
};

const RESIDENCY_LABELS: Record<ResidencyStatus, string> = {
  over_183: "在台居留滿 183 天",
  under_183: "在台居留未滿 183 天",
};

const ATTACHMENT_TYPE_LABELS: Record<AttachmentType, string> = {
  general: "一般附件",
  contract: "合約",
};

/** Radix Select 不收空字串當 value，所以「不指定」用哨兵值（與 VendorSelect 同一條）。 */
const NONE = "__none__";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 空字串 → null。整份 payload 的規矩：沒填就是 null，不是 ""。 */
function nz(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function intOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

/** 0–1 小數 → 畫面上的百分比字串。0.1115 → "11.15"（不是 11.150000000000002）。 */
function rateToPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "";
  return String(Number((rate * 100).toFixed(4)));
}

/** 畫面上的百分比字串 → 0–1 小數。空字串是 null（資料庫會套自己的預設值）。 */
function percentToRate(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return Number.NaN;
  return Number((n / 100).toFixed(6));
}

// ---------------------------------------------------------------------------
// 表單狀態
// ---------------------------------------------------------------------------

type FormState = {
  entity_type: EntityType;
  category_id: string | null;
  name: string;
  name_en: string;
  short_name: string;
  representative: string;
  is_preferred: boolean;
  notes: string;
  tax_id: string;
  id_number: string;
  foreign_id: string;
  foreign_id_type: string;
  residence_permit_number: string;
  taiwan_residency_status: ResidencyStatus | null;
  country_code: string;
  status: VendorStatus;

  phone: string;
  fax: string;
  email: string;
  address: string;
  address_en: string;
  invoice_address: string;

  default_tax_type_id: string | null;
  default_withholding_category_id: string | null;
  is_nhi_applicable: boolean;
  voucher_category: VoucherCategory;
  einvoice_type: EinvoiceType;
  payment_terms: PaymentTerms;
  payment_terms_note: string;
  settlement_type: SettlementType;
  settlement_start_day: string;
  settlement_interval_days: string;
  bill_due_day: string;
  is_consignment: boolean;
  /** 以下四個是**百分比字串**，送出前才換算成 0–1 小數。 */
  cash_fee_rate: string;
  domestic_card_fee_rate: string;
  foreign_card_fee_rate: string;
  commission_rate: string;
};

/**
 * 新增時的預設值。
 *
 * 三個手續費率的預設值與 inv_save_vendor() 的 COALESCE 一致（0.08 / 0.101 /
 * 0.1115）—— 先填出來而不是留空，是為了讓人看得到「不填會變成這個數字」。
 */
const EMPTY_FORM: FormState = {
  entity_type: "domestic_company",
  category_id: null,
  name: "",
  name_en: "",
  short_name: "",
  representative: "",
  is_preferred: false,
  notes: "",
  tax_id: "",
  id_number: "",
  foreign_id: "",
  foreign_id_type: "",
  residence_permit_number: "",
  taiwan_residency_status: null,
  country_code: "",
  status: "active",
  phone: "",
  fax: "",
  email: "",
  address: "",
  address_en: "",
  invoice_address: "",
  default_tax_type_id: null,
  default_withholding_category_id: null,
  is_nhi_applicable: false,
  voucher_category: "invoice",
  einvoice_type: "none",
  payment_terms: "immediate",
  payment_terms_note: "",
  settlement_type: "invoice_date",
  settlement_start_day: "",
  settlement_interval_days: "",
  bill_due_day: "",
  is_consignment: false,
  cash_fee_rate: "8",
  domestic_card_fee_rate: "10.1",
  foreign_card_fee_rate: "11.15",
  commission_rate: "",
};

function formFromDetail(detail: AdminVendorDetail): FormState {
  const entity = VENDOR_ENTITY_TYPES.find((t) => t === detail.entity_type) ?? "domestic_company";
  const status = VENDOR_STATUSES.find((s) => s === detail.status) ?? "active";
  const voucher = VENDOR_VOUCHER_CATEGORIES.find((v) => v === detail.voucher_category) ?? "invoice";
  const einvoice = VENDOR_EINVOICE_TYPES.find((v) => v === detail.einvoice_type) ?? "none";
  const terms = VENDOR_PAYMENT_TERMS.find((v) => v === detail.payment_terms) ?? "immediate";
  const settlement =
    VENDOR_SETTLEMENT_TYPES.find((v) => v === detail.settlement_type) ?? "invoice_date";
  const residency =
    VENDOR_RESIDENCY_STATUSES.find((v) => v === detail.taiwan_residency_status) ?? null;

  return {
    entity_type: entity,
    category_id: detail.category_id,
    name: detail.name,
    name_en: detail.name_en ?? "",
    short_name: detail.short_name ?? "",
    representative: detail.representative ?? "",
    is_preferred: detail.is_preferred ?? false,
    notes: detail.notes ?? "",
    // ⚠️ 這四個**刻意留空**。detail 上只有 *_masked，把遮罩填進來就會被存回資料庫。
    tax_id: "",
    id_number: "",
    foreign_id: "",
    residence_permit_number: "",
    foreign_id_type: detail.foreign_id_type ?? "",
    taiwan_residency_status: residency,
    country_code: detail.country_code ?? "",
    status,
    phone: detail.phone ?? "",
    fax: detail.fax ?? "",
    email: detail.email ?? "",
    address: detail.address ?? "",
    address_en: detail.address_en ?? "",
    invoice_address: detail.invoice_address ?? "",
    default_tax_type_id: detail.default_tax_type_id,
    default_withholding_category_id: detail.default_withholding_category_id,
    is_nhi_applicable: detail.is_nhi_applicable ?? false,
    voucher_category: voucher,
    einvoice_type: einvoice,
    payment_terms: terms,
    payment_terms_note: detail.payment_terms_note ?? "",
    settlement_type: settlement,
    settlement_start_day: detail.settlement_start_day?.toString() ?? "",
    settlement_interval_days: detail.settlement_interval_days?.toString() ?? "",
    bill_due_day: detail.bill_due_day?.toString() ?? "",
    is_consignment: detail.is_consignment,
    cash_fee_rate: rateToPercent(detail.cash_fee_rate),
    domestic_card_fee_rate: rateToPercent(detail.domestic_card_fee_rate),
    foreign_card_fee_rate: rateToPercent(detail.foreign_card_fee_rate),
    commission_rate: rateToPercent(detail.commission_rate),
  };
}

// ---------------------------------------------------------------------------
// 識別碼欄位 —— 遮罩顯示 + 「更改」
// ---------------------------------------------------------------------------

const SENSITIVE_KEYS = ["tax_id", "id_number", "foreign_id", "residence_permit_number"] as const;
type SensitiveKey = (typeof SENSITIVE_KEYS)[number];

const SENSITIVE_LABELS: Record<SensitiveKey, string> = {
  tax_id: "統一編號",
  id_number: "身分證字號",
  foreign_id: "國外識別碼",
  residence_permit_number: "居留證號碼",
};

/**
 * 一個識別碼欄位。
 *
 * ⚠️ 有遮罩而且沒按「更改」的時候，這裡渲染的是**文字**不是 input —— 遮罩值連
 *    進到表單 state 的機會都沒有，所以不可能被送出去。
 */
function IdentityField({
  id,
  label,
  masked,
  changing,
  value,
  disabled,
  required,
  onStartChange,
  onCancelChange,
  onChange,
}: {
  id: string;
  label: string;
  /** null = 這家還沒填過這個識別碼，直接給輸入框。 */
  masked: string | null;
  changing: boolean;
  value: string;
  disabled: boolean;
  required: boolean;
  onStartChange: () => void;
  onCancelChange: () => void;
  onChange: (next: string) => void;
}) {
  if (masked !== null && !changing) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {label}
          {required ? <span className="ml-1 text-destructive">*</span> : null}
        </Label>
        <div className="flex items-center gap-2">
          <span
            id={id}
            className="flex h-9 flex-1 items-center rounded-md border border-border bg-muted/40 px-3 font-mono text-sm tabular-nums text-muted-foreground"
          >
            {masked}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={onStartChange}
          >
            更改
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          目前只看得到遮罩。要更改必須重新輸入完整號碼。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          className="flex-1"
          value={value}
          disabled={disabled}
          autoComplete="off"
          placeholder={masked === null ? "" : "請輸入完整號碼"}
          onChange={(e) => onChange(e.target.value)}
        />
        {masked !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={onCancelChange}
          >
            取消更改
          </Button>
        ) : null}
      </div>
      {masked !== null ? (
        <p className="text-xs text-amber-700">
          要輸入<strong>完整</strong>號碼。系統讀不回原值，這一格會直接覆寫資料庫。
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主元件
// ---------------------------------------------------------------------------

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

  /**
   * 哪幾個識別碼要畫出來 —— 兩個來源的**聯集**：
   *   ① 這個 entity_type 用得到的（新增時只有這一條）
   *   ② 這家**已經有值**的，不管現在的 entity_type 是什麼
   *
   * ⚠️ 第二條不能省。inv.vendors 的 CHECK 只管「該填的有沒有填」，沒有禁止一家
   *    domestic_company 同時留著 id_number（0009 從舊系統搬進來的資料就可能這樣）。
   *    如果只照 entity_type 顯示，那個有值卻沒被畫出來的欄位會永遠停在「還沒按更改」
   *    的狀態 —— 於是 lockedKeys 擋住儲存，而使用者在畫面上根本找不到要按哪一顆。
   *    畫出來，他才有辦法重新輸入或清掉它。
   */
  const visible: Record<SensitiveKey, boolean> = {
    tax_id: form.entity_type === "domestic_company" || masks.tax_id !== null,
    id_number: form.entity_type === "domestic_individual" || masks.id_number !== null,
    foreign_id:
      form.entity_type === "foreign" ||
      form.entity_type === "foreign_individual" ||
      masks.foreign_id !== null,
    residence_permit_number:
      form.entity_type === "foreign_individual" || masks.residence_permit_number !== null,
  };

  async function save() {
    if (lockedKeys.length > 0) {
      toast.error(
        `請先按「更改」重新輸入完整的${lockedKeys.map((k) => SENSITIVE_LABELS[k]).join("、")}` +
          "（系統讀不回原值，儲存會直接覆寫資料庫）",
      );
      setTab("basic");
      return;
    }

    const parsed = vendorSchema.safeParse({
      id: vendorId,
      entity_type: form.entity_type,
      category_id: form.category_id,
      name: form.name,
      name_en: nz(form.name_en),
      short_name: nz(form.short_name),
      representative: nz(form.representative),
      is_preferred: form.is_preferred,
      notes: nz(form.notes),
      tax_id: nz(form.tax_id),
      id_number: nz(form.id_number),
      foreign_id: nz(form.foreign_id),
      foreign_id_type: nz(form.foreign_id_type),
      residence_permit_number: nz(form.residence_permit_number),
      taiwan_residency_status: form.taiwan_residency_status,
      country_code: nz(form.country_code),
      phone: nz(form.phone),
      fax: nz(form.fax),
      email: nz(form.email),
      address: nz(form.address),
      address_en: nz(form.address_en),
      invoice_address: nz(form.invoice_address),
      default_tax_type_id: form.default_tax_type_id,
      default_withholding_category_id: form.default_withholding_category_id,
      is_nhi_applicable: form.is_nhi_applicable,
      voucher_category: form.voucher_category,
      einvoice_type: form.einvoice_type,
      payment_terms: form.payment_terms,
      payment_terms_note: nz(form.payment_terms_note),
      settlement_type: form.settlement_type,
      settlement_start_day: intOrNull(form.settlement_start_day),
      settlement_interval_days: intOrNull(form.settlement_interval_days),
      bill_due_day: intOrNull(form.bill_due_day),
      is_consignment: form.is_consignment,
      cash_fee_rate: percentToRate(form.cash_fee_rate),
      domestic_card_fee_rate: percentToRate(form.domestic_card_fee_rate),
      foreign_card_fee_rate: percentToRate(form.foreign_card_fee_rate),
      commission_rate: percentToRate(form.commission_rate),
      status: form.status,
    });

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

  const entity = form.entity_type;
  const busy = saving || loading;

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {editing ? `編輯廠商：${editing.name}` : "新增廠商"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? `${editing.vendor_code ?? "（未編號）"}・編輯不會改變審核狀態。`
              : approvalOn
                ? "廠商目前需要審核：儲存之後會進入待審核，核准後才能開始往來。"
                : "廠商目前不需要審核，儲存後即可開始往來。"}
          </DialogDescription>
        </DialogHeader>

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

            {/* ---------------------------------------------------------- */}
            {/* 分頁一：基本／識別                                          */}
            {/* ---------------------------------------------------------- */}
            <TabsContent value="basic" className="space-y-4 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="vendor-entity">實體類型</Label>
                  <Select
                    value={entity}
                    disabled={busy}
                    onValueChange={(v) => patch({ entity_type: v as EntityType })}
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
                    onValueChange={(v) => patch({ category_id: v === NONE ? null : v })}
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
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vendor-name-en">英文名稱</Label>
                  <Input
                    id="vendor-name-en"
                    value={form.name_en}
                    disabled={busy}
                    onChange={(e) => patch({ name_en: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vendor-short">簡稱</Label>
                  <Input
                    id="vendor-short"
                    placeholder="單據上顯示的短名"
                    value={form.short_name}
                    disabled={busy}
                    onChange={(e) => patch({ short_name: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vendor-rep">負責人／代表人</Label>
                  <Input
                    id="vendor-rep"
                    value={form.representative}
                    disabled={busy}
                    onChange={(e) => patch({ representative: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vendor-status">往來狀態</Label>
                  <Select
                    value={form.status}
                    disabled={busy}
                    onValueChange={(v) => patch({ status: v as VendorStatus })}
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
                    onCheckedChange={(v) => patch({ is_preferred: v })}
                  />
                  <Label htmlFor="vendor-preferred" className="cursor-pointer">
                    優先供應商
                  </Label>
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
                  <p className="text-sm font-medium">識別碼</p>
                </div>

                {editing ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                    畫面上顯示的是<strong>遮罩</strong>，完整號碼沒有送到瀏覽器。
                    <strong>更改識別碼需要重新輸入完整號碼</strong> —— 儲存是直接覆寫，
                    把遮罩存回去等於毀掉這家廠商的統編。要查原值請用清單上的「完整號碼」，
                    那會留下一筆查閱紀錄。
                  </div>
                ) : null}

                <div className="grid gap-4 sm:grid-cols-2">
                  {/* 顯示條件見上面的 visible：entity_type 用得到的 ∪ 這家已經有值的。
                      四條必填規則在 vendorSchema 與 inv_save_vendor() 各守一次，
                      這裡的 required 只是把星號畫在對的地方。 */}
                  {visible.tax_id ? (
                    <IdentityField
                      id="vendor-tax-id"
                      label={SENSITIVE_LABELS.tax_id}
                      masked={masks.tax_id}
                      changing={changing.tax_id}
                      value={form.tax_id}
                      disabled={busy}
                      required={entity === "domestic_company"}
                      onStartChange={() => setChanging((p) => ({ ...p, tax_id: true }))}
                      onCancelChange={() => {
                        setChanging((p) => ({ ...p, tax_id: false }));
                        patch({ tax_id: "" });
                      }}
                      onChange={(v) => patch({ tax_id: v })}
                    />
                  ) : null}

                  {visible.id_number ? (
                    <IdentityField
                      id="vendor-id-number"
                      label={SENSITIVE_LABELS.id_number}
                      masked={masks.id_number}
                      changing={changing.id_number}
                      value={form.id_number}
                      disabled={busy}
                      required={entity === "domestic_individual"}
                      onStartChange={() => setChanging((p) => ({ ...p, id_number: true }))}
                      onCancelChange={() => {
                        setChanging((p) => ({ ...p, id_number: false }));
                        patch({ id_number: "" });
                      }}
                      onChange={(v) => patch({ id_number: v })}
                    />
                  ) : null}

                  {visible.foreign_id ? (
                    <IdentityField
                      id="vendor-foreign-id"
                      label={SENSITIVE_LABELS.foreign_id}
                      masked={masks.foreign_id}
                      changing={changing.foreign_id}
                      value={form.foreign_id}
                      disabled={busy}
                      required={entity === "foreign"}
                      onStartChange={() => setChanging((p) => ({ ...p, foreign_id: true }))}
                      onCancelChange={() => {
                        setChanging((p) => ({ ...p, foreign_id: false }));
                        patch({ foreign_id: "" });
                      }}
                      onChange={(v) => patch({ foreign_id: v })}
                    />
                  ) : null}

                  {entity === "foreign" || entity === "foreign_individual" ? (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="vendor-foreign-id-type">識別碼種類</Label>
                        <Input
                          id="vendor-foreign-id-type"
                          placeholder="例：護照號碼、稅籍編號"
                          value={form.foreign_id_type}
                          disabled={busy}
                          onChange={(e) => patch({ foreign_id_type: e.target.value })}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="vendor-country">國別代碼</Label>
                        <Input
                          id="vendor-country"
                          placeholder="例：JP、US（三碼以內）"
                          maxLength={3}
                          value={form.country_code}
                          disabled={busy}
                          onChange={(e) => patch({ country_code: e.target.value })}
                        />
                      </div>
                    </>
                  ) : null}

                  {visible.residence_permit_number ? (
                    <IdentityField
                      id="vendor-permit"
                      label={SENSITIVE_LABELS.residence_permit_number}
                      masked={masks.residence_permit_number}
                      changing={changing.residence_permit_number}
                      value={form.residence_permit_number}
                      disabled={busy}
                      // 居留證號碼永遠不是單獨必填的：foreign_individual 只要求
                      // 「國外識別碼或居留證號碼至少一個」，那條規則由 zod 的 refine 判。
                      required={false}
                      onStartChange={() =>
                        setChanging((p) => ({ ...p, residence_permit_number: true }))
                      }
                      onCancelChange={() => {
                        setChanging((p) => ({ ...p, residence_permit_number: false }));
                        patch({ residence_permit_number: "" });
                      }}
                      onChange={(v) => patch({ residence_permit_number: v })}
                    />
                  ) : null}

                  {entity === "foreign_individual" ? (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="vendor-residency">在台居留狀態</Label>
                        <Select
                          value={form.taiwan_residency_status ?? NONE}
                          disabled={busy}
                          onValueChange={(v) =>
                            patch({
                              taiwan_residency_status: v === NONE ? null : (v as ResidencyStatus),
                            })
                          }
                        >
                          <SelectTrigger id="vendor-residency">
                            <SelectValue placeholder="未指定" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>未指定</SelectItem>
                            {VENDOR_RESIDENCY_STATUSES.map((code) => (
                              <SelectItem key={code} value={code}>
                                {RESIDENCY_LABELS[code]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">影響扣繳稅率，會計要看。</p>
                      </div>
                    </>
                  ) : null}

                  {entity === "foreign_individual" ? (
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      國外個人：國外識別碼與居留證號碼<strong>至少要填一個</strong>。
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="vendor-notes">備註</Label>
                <Textarea
                  id="vendor-notes"
                  rows={3}
                  value={form.notes}
                  disabled={busy}
                  onChange={(e) => patch({ notes: e.target.value })}
                />
              </div>
            </TabsContent>

            {/* ---------------------------------------------------------- */}
            {/* 分頁二：聯絡                                                */}
            {/* ---------------------------------------------------------- */}
            <TabsContent value="contact" className="space-y-4 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="vendor-phone">電話</Label>
                  <Input
                    id="vendor-phone"
                    value={form.phone}
                    disabled={busy}
                    onChange={(e) => patch({ phone: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vendor-fax">傳真</Label>
                  <Input
                    id="vendor-fax"
                    value={form.fax}
                    disabled={busy}
                    onChange={(e) => patch({ fax: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="vendor-email">電子郵件</Label>
                  <Input
                    id="vendor-email"
                    type="email"
                    value={form.email}
                    disabled={busy}
                    onChange={(e) => patch({ email: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="vendor-address">地址</Label>
                  <Input
                    id="vendor-address"
                    value={form.address}
                    disabled={busy}
                    onChange={(e) => patch({ address: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="vendor-address-en">英文地址</Label>
                  <Input
                    id="vendor-address-en"
                    value={form.address_en}
                    disabled={busy}
                    onChange={(e) => patch({ address_en: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="vendor-invoice-address">發票寄送地址</Label>
                  <Input
                    id="vendor-invoice-address"
                    placeholder="與公司地址不同時才填"
                    value={form.invoice_address}
                    disabled={busy}
                    onChange={(e) => patch({ invoice_address: e.target.value })}
                  />
                </div>
              </div>

              <Separator />

              <ContactSection
                vendorId={vendorId}
                rows={contacts}
                disabled={busy}
                onReload={reloadChildren}
              />
            </TabsContent>

            {/* ---------------------------------------------------------- */}
            {/* 分頁三：財務／寄售                                          */}
            {/* ---------------------------------------------------------- */}
            <TabsContent value="finance" className="space-y-4 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="vendor-tax-type">預設稅別</Label>
                  <Select
                    value={form.default_tax_type_id ?? NONE}
                    disabled={busy}
                    onValueChange={(v) => patch({ default_tax_type_id: v === NONE ? null : v })}
                  >
                    <SelectTrigger id="vendor-tax-type">
                      <SelectValue placeholder="未指定" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>未指定</SelectItem>
                      {taxTypes.map((t) => (
                        <SelectItem key={t.tax_type_id} value={t.tax_type_id}>
                          {t.code}・{t.name}（{Number((t.rate * 100).toFixed(2))}%）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vendor-withholding">預設扣繳類別</Label>
                  <Select
                    value={form.default_withholding_category_id ?? NONE}
                    disabled={busy}
                    onValueChange={(v) =>
                      patch({ default_withholding_category_id: v === NONE ? null : v })
                    }
                  >
                    <SelectTrigger id="vendor-withholding">
                      <SelectValue placeholder="未指定" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>未指定</SelectItem>
                      {withholdingCategories.map((w) => (
                        <SelectItem
                          key={w.withholding_category_id}
                          value={w.withholding_category_id}
                        >
                          {w.code}・{w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vendor-voucher">憑證種類</Label>
                  <Select
                    value={form.voucher_category}
                    disabled={busy}
                    onValueChange={(v) => patch({ voucher_category: v as VoucherCategory })}
                  >
                    <SelectTrigger id="vendor-voucher">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VENDOR_VOUCHER_CATEGORIES.map((code) => (
                        <SelectItem key={code} value={code}>
                          {VOUCHER_LABELS[code]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vendor-einvoice">電子發票</Label>
                  <Select
                    value={form.einvoice_type}
                    disabled={busy}
                    onValueChange={(v) => patch({ einvoice_type: v as EinvoiceType })}
                  >
                    <SelectTrigger id="vendor-einvoice">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VENDOR_EINVOICE_TYPES.map((code) => (
                        <SelectItem key={code} value={code}>
                          {EINVOICE_LABELS[code]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-2 rounded-md border border-border p-3 sm:col-span-2">
                  <Switch
                    id="vendor-nhi"
                    checked={form.is_nhi_applicable}
                    disabled={busy}
                    onCheckedChange={(v) => patch({ is_nhi_applicable: v })}
                  />
                  <Label htmlFor="vendor-nhi" className="cursor-pointer">
                    需扣二代健保補充保費
                  </Label>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vendor-terms">付款條件</Label>
                  <Select
                    value={form.payment_terms}
                    disabled={busy}
                    onValueChange={(v) => patch({ payment_terms: v as PaymentTerms })}
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
                    onChange={(e) => patch({ payment_terms_note: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="vendor-settlement">結算方式</Label>
                  <Select
                    value={form.settlement_type}
                    disabled={busy}
                    onValueChange={(v) => patch({ settlement_type: v as SettlementType })}
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
                    onChange={(e) => patch({ settlement_start_day: e.target.value })}
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
                    onChange={(e) => patch({ settlement_interval_days: e.target.value })}
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
                    onChange={(e) => patch({ bill_due_day: e.target.value })}
                  />
                </div>
              </div>

              <Separator />

              <div className="flex items-center gap-2 rounded-md border border-border p-3">
                <Switch
                  id="vendor-consignment"
                  checked={form.is_consignment}
                  disabled={busy}
                  onCheckedChange={(v) => patch({ is_consignment: v })}
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
                  onChange={(v) => patch({ cash_fee_rate: v })}
                />
                <RateField
                  id="vendor-domestic-fee"
                  label="國內刷卡 %"
                  value={form.domestic_card_fee_rate}
                  disabled={busy}
                  onChange={(v) => patch({ domestic_card_fee_rate: v })}
                />
                <RateField
                  id="vendor-foreign-fee"
                  label="國外刷卡 %"
                  value={form.foreign_card_fee_rate}
                  disabled={busy}
                  onChange={(v) => patch({ foreign_card_fee_rate: v })}
                />
                <RateField
                  id="vendor-commission"
                  label="寄售抽成 %"
                  value={form.commission_rate}
                  disabled={busy}
                  onChange={(v) => patch({ commission_rate: v })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                空白代表沿用資料庫預設（現金 8%、國內刷卡 10.1%、國外刷卡 11.15%）。
                抽成留空就是沒有抽成。
              </p>

              <Separator />

              <BankAccountSection
                vendorId={vendorId}
                rows={bankAccounts}
                disabled={busy}
                onReload={reloadChildren}
              />
            </TabsContent>

            {/* ---------------------------------------------------------- */}
            {/* 分頁四：附件／合約                                          */}
            {/* ---------------------------------------------------------- */}
            <TabsContent value="files" className="space-y-4 pt-4">
              <AttachmentSection
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

// ---------------------------------------------------------------------------
// 費率欄位
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 聯絡人子表
// ---------------------------------------------------------------------------

type ContactDraft = {
  id: string | null;
  name: string;
  job_title: string;
  phone: string;
  mobile: string;
  email: string;
  is_primary: boolean;
  is_finance_contact: boolean;
  notes: string;
  sort_order: string;
};

const EMPTY_CONTACT: ContactDraft = {
  id: null,
  name: "",
  job_title: "",
  phone: "",
  mobile: "",
  email: "",
  is_primary: false,
  is_finance_contact: false,
  notes: "",
  sort_order: "0",
};

function ContactSection({
  vendorId,
  rows,
  disabled,
  onReload,
}: {
  vendorId: string | null;
  rows: AdminVendorContact[];
  disabled: boolean;
  onReload: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [busy, setBusy] = useState(false);

  if (!vendorId) {
    return (
      <ChildPlaceholder>
        先把基本資料存起來，才能新增聯絡人 —— 聯絡人是掛在廠商底下的獨立資料。
      </ChildPlaceholder>
    );
  }

  async function save() {
    if (!draft || !vendorId) return;
    const parsed = vendorContactSchema.safeParse({
      id: draft.id,
      name: draft.name,
      job_title: nz(draft.job_title),
      phone: nz(draft.phone),
      mobile: nz(draft.mobile),
      email: nz(draft.email),
      is_primary: draft.is_primary,
      is_finance_contact: draft.is_finance_contact,
      notes: nz(draft.notes),
      sort_order: intOrNull(draft.sort_order) ?? 0,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查聯絡人的內容");
      return;
    }

    setBusy(true);
    try {
      const { saveVendorContact } = await import("@/lib/admin/fns/inv-vendors");
      await saveVendorContact({ data: { vendorId, contact: parsed.data } });
      toast.success(`聯絡人「${parsed.data.name}」已儲存`);
      setDraft(null);
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "聯絡人儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: AdminVendorContact) {
    if (!vendorId) return;
    setBusy(true);
    try {
      const { deleteVendorChild } = await import("@/lib/admin/fns/inv-vendors");
      await deleteVendorChild({ data: { kind: "contact", vendorId, id: row.contact_id } });
      toast.success(`已刪除聯絡人「${row.name}」`);
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">聯絡人（{rows.length}）</p>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={disabled || busy || draft !== null}
          onClick={() => setDraft(EMPTY_CONTACT)}
        >
          <Plus className="h-3.5 w-3.5" />
          新增聯絡人
        </Button>
      </div>

      {rows.length === 0 && draft === null ? (
        <p className="text-sm text-muted-foreground">還沒有聯絡人。</p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.contact_id}
            className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3"
          >
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {row.name}
                {row.job_title ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">{row.job_title}</span>
                ) : null}
                {row.is_primary ? (
                  <Badge variant="secondary" className="ml-1.5 font-normal">
                    主要
                  </Badge>
                ) : null}
                {row.is_finance_contact ? (
                  <Badge variant="outline" className="ml-1.5 font-normal">
                    財務
                  </Badge>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {[row.phone, row.mobile, row.email].filter(Boolean).join("・") || "沒有留聯絡方式"}
              </p>
              {row.notes ? <p className="text-xs text-muted-foreground">{row.notes}</p> : null}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                onClick={() =>
                  setDraft({
                    id: row.contact_id,
                    name: row.name,
                    job_title: row.job_title ?? "",
                    phone: row.phone ?? "",
                    mobile: row.mobile ?? "",
                    email: row.email ?? "",
                    is_primary: row.is_primary ?? false,
                    is_finance_contact: row.is_finance_contact ?? false,
                    notes: row.notes ?? "",
                    sort_order: row.sort_order?.toString() ?? "0",
                  })
                }
              >
                編輯
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10"
                disabled={disabled || busy}
                onClick={() => void remove(row)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-name">姓名</Label>
              <Input
                id="contact-name"
                value={draft.name}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-title">職稱</Label>
              <Input
                id="contact-title"
                value={draft.job_title}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, job_title: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-phone">電話</Label>
              <Input
                id="contact-phone"
                value={draft.phone}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-mobile">手機</Label>
              <Input
                id="contact-mobile"
                value={draft.mobile}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, mobile: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-email">電子郵件</Label>
              <Input
                id="contact-email"
                type="email"
                value={draft.email}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
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
                onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Switch
                checked={draft.is_primary}
                disabled={busy}
                onCheckedChange={(v) => setDraft({ ...draft, is_primary: v })}
              />
              主要聯絡人
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Switch
                checked={draft.is_finance_contact}
                disabled={busy}
                onCheckedChange={(v) => setDraft({ ...draft, is_finance_contact: v })}
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
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => void save()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              儲存聯絡人
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 匯款帳戶子表
// ---------------------------------------------------------------------------

type BankDraft = {
  id: string | null;
  /** 既有帳號的遮罩。null = 新增。 */
  masked: string | null;
  changingNumber: boolean;
  account_holder_name: string;
  bank_code: string;
  bank_name: string;
  branch_code: string;
  branch_name: string;
  account_number: string;
  account_purpose: string;
  is_default: boolean;
  notes: string;
  sort_order: string;
};

const EMPTY_BANK: BankDraft = {
  id: null,
  masked: null,
  changingNumber: false,
  account_holder_name: "",
  bank_code: "",
  bank_name: "",
  branch_code: "",
  branch_name: "",
  account_number: "",
  account_purpose: "",
  is_default: false,
  notes: "",
  sort_order: "0",
};

/**
 * 匯款帳戶。
 *
 * ⚠️ 帳號與識別碼是同一個問題：清單回來的是 `account_number_masked`，
 *    `vendorBankAccountSchema.account_number` 又是必填，所以編輯既有帳戶時必須
 *    重新輸入完整帳號。這裡沿用同一顆「更改」按鈕，理由見檔頭第 1 點。
 */
function BankAccountSection({
  vendorId,
  rows,
  disabled,
  onReload,
}: {
  vendorId: string | null;
  rows: AdminVendorBankAccount[];
  disabled: boolean;
  onReload: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<BankDraft | null>(null);
  const [busy, setBusy] = useState(false);

  if (!vendorId) {
    return <ChildPlaceholder>先把基本資料存起來，才能新增匯款帳戶。</ChildPlaceholder>;
  }

  async function save() {
    if (!draft || !vendorId) return;
    if (draft.masked !== null && !draft.changingNumber) {
      toast.error("請先按「更改」重新輸入完整帳號（系統讀不回原值，儲存會直接覆寫）");
      return;
    }

    const parsed = vendorBankAccountSchema.safeParse({
      id: draft.id,
      account_holder_name: draft.account_holder_name,
      bank_code: draft.bank_code,
      bank_name: draft.bank_name,
      branch_code: nz(draft.branch_code),
      branch_name: nz(draft.branch_name),
      account_number: draft.account_number,
      account_purpose: nz(draft.account_purpose),
      is_default: draft.is_default,
      notes: nz(draft.notes),
      sort_order: intOrNull(draft.sort_order) ?? 0,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查匯款帳戶的內容");
      return;
    }

    setBusy(true);
    try {
      const { saveVendorBankAccount } = await import("@/lib/admin/fns/inv-vendors");
      await saveVendorBankAccount({ data: { vendorId, account: parsed.data } });
      toast.success(`匯款帳戶「${parsed.data.account_holder_name}」已儲存`);
      setDraft(null);
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "匯款帳戶儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: AdminVendorBankAccount) {
    if (!vendorId) return;
    setBusy(true);
    try {
      const { deleteVendorChild } = await import("@/lib/admin/fns/inv-vendors");
      await deleteVendorChild({
        data: { kind: "bank_account", vendorId, id: row.bank_account_id },
      });
      toast.success(`已刪除「${row.account_holder_name}」的匯款帳戶`);
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">匯款帳戶（{rows.length}）</p>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={disabled || busy || draft !== null}
          onClick={() => setDraft(EMPTY_BANK)}
        >
          <Plus className="h-3.5 w-3.5" />
          新增帳戶
        </Button>
      </div>

      {rows.length === 0 && draft === null ? (
        <p className="text-sm text-muted-foreground">還沒有匯款帳戶。</p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.bank_account_id}
            className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3"
          >
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {row.account_holder_name}
                {row.is_default ? (
                  <Badge variant="secondary" className="ml-1.5 font-normal">
                    預設
                  </Badge>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {row.bank_code} {row.bank_name}
                {row.branch_name ? `・${row.branch_name}` : ""}
              </p>
              {/* ⚠️ 這裡永遠是遮罩。完整帳號走 VendorSensitiveDialog（會留紀錄）。 */}
              <p className="font-mono text-xs tabular-nums text-muted-foreground">
                {row.account_number_masked ?? "—"}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                onClick={() =>
                  setDraft({
                    id: row.bank_account_id,
                    masked: row.account_number_masked,
                    changingNumber: false,
                    account_holder_name: row.account_holder_name,
                    bank_code: row.bank_code,
                    bank_name: row.bank_name,
                    branch_code: row.branch_code ?? "",
                    branch_name: row.branch_name ?? "",
                    account_number: "",
                    account_purpose: row.account_purpose ?? "",
                    is_default: row.is_default ?? false,
                    notes: row.notes ?? "",
                    sort_order: row.sort_order?.toString() ?? "0",
                  })
                }
              >
                編輯
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10"
                disabled={disabled || busy}
                onClick={() => void remove(row)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bank-holder">戶名</Label>
              <Input
                id="bank-holder"
                value={draft.account_holder_name}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, account_holder_name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bank-purpose">用途</Label>
              <Input
                id="bank-purpose"
                placeholder="例：貨款、版稅"
                value={draft.account_purpose}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, account_purpose: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bank-code">銀行代碼</Label>
              <Input
                id="bank-code"
                maxLength={5}
                value={draft.bank_code}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, bank_code: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bank-name">銀行名稱</Label>
              <Input
                id="bank-name"
                value={draft.bank_name}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, bank_name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bank-branch-code">分行代碼</Label>
              <Input
                id="bank-branch-code"
                maxLength={10}
                value={draft.branch_code}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, branch_code: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bank-branch-name">分行名稱</Label>
              <Input
                id="bank-branch-name"
                value={draft.branch_name}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, branch_name: e.target.value })}
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
                onStartChange={() => setDraft({ ...draft, changingNumber: true })}
                onCancelChange={() =>
                  setDraft({ ...draft, changingNumber: false, account_number: "" })
                }
                onChange={(v) => setDraft({ ...draft, account_number: v })}
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
                onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })}
              />
            </div>

            <div className="flex items-center gap-2 self-end rounded-md border border-border p-3">
              <Switch
                id="bank-default"
                checked={draft.is_default}
                disabled={busy}
                onCheckedChange={(v) => setDraft({ ...draft, is_default: v })}
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
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => void save()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              儲存帳戶
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 附件／合約子表
// ---------------------------------------------------------------------------

type AttachmentDraft = {
  file: File | null;
  file_name: string;
  description: string;
  attachment_type: AttachmentType;
  contract_start_date: string;
  contract_end_date: string;
  contract_version: string;
  is_current: boolean;
};

const EMPTY_ATTACHMENT: AttachmentDraft = {
  file: null,
  file_name: "",
  description: "",
  attachment_type: "general",
  contract_start_date: "",
  contract_end_date: "",
  contract_version: "",
  is_current: true,
};

/**
 * 附件。
 *
 * ⚠️ 流程是 **先填完再上傳**：選檔案只是記在 state 裡，按下「上傳並儲存」才真的
 *    `uploadVendorAttachmentFile`（FormData）→ 拿到 key → `saveVendorAttachment`。
 *    反過來（選完就上傳）的話，使用者中途放棄會在 storage 留下一個沒有人指得到的
 *    孤兒檔案。
 *
 * ⚠️ 看檔案要走 `signVendorAttachment` 拿短效網址再開新分頁 —— bucket 是 private，
 *    沒有永久網址這種東西。網址有時效，所以每次點都重新簽一次，不快取。
 */
function AttachmentSection({
  vendorId,
  rows,
  disabled,
  onReload,
}: {
  vendorId: string | null;
  rows: AdminVendorAttachment[];
  disabled: boolean;
  onReload: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<AttachmentDraft>(EMPTY_ATTACHMENT);
  const [busy, setBusy] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!vendorId) {
    return (
      <ChildPlaceholder>
        先把基本資料存起來，才能上傳附件與合約 —— 檔案是存在以 vendor_id 為第一段路徑的 私有 bucket
        裡，沒有 id 就沒有路徑。
      </ChildPlaceholder>
    );
  }

  async function upload() {
    if (!vendorId) return;
    if (!draft.file) {
      toast.error("請選擇檔案");
      return;
    }

    setBusy(true);
    try {
      const { uploadVendorAttachmentFile, saveVendorAttachment } =
        await import("@/lib/admin/fns/inv-vendors");

      const formData = new FormData();
      formData.append("file", draft.file);
      formData.append("vendorId", vendorId);
      const uploaded = await uploadVendorAttachmentFile({ data: formData });

      const parsed = vendorAttachmentSchema.safeParse({
        file_name: draft.file_name.trim() === "" ? draft.file.name : draft.file_name,
        file_path: uploaded.key,
        file_type: uploaded.fileType,
        file_size: uploaded.fileSize,
        description: nz(draft.description),
        attachment_type: draft.attachment_type,
        contract_start_date: nz(draft.contract_start_date),
        contract_end_date: nz(draft.contract_end_date),
        contract_version: nz(draft.contract_version),
        is_current: draft.is_current,
      });
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? "請檢查附件的內容");
        return;
      }

      await saveVendorAttachment({ data: { vendorId, attachment: parsed.data } });
      toast.success(`附件「${parsed.data.file_name}」已上傳`);
      setDraft(EMPTY_ATTACHMENT);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "附件上傳失敗");
    } finally {
      setBusy(false);
    }
  }

  async function view(row: AdminVendorAttachment) {
    if (!vendorId) return;
    setOpeningId(row.attachment_id);
    try {
      const { signVendorAttachment } = await import("@/lib/admin/fns/inv-vendors");
      const { url } = await signVendorAttachment({
        data: { vendorId, filePath: row.file_path },
      });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "附件網址產生失敗");
    } finally {
      setOpeningId(null);
    }
  }

  async function remove(row: AdminVendorAttachment) {
    if (!vendorId) return;
    setBusy(true);
    try {
      const { deleteVendorChild } = await import("@/lib/admin/fns/inv-vendors");
      await deleteVendorChild({
        data: { kind: "attachment", vendorId, id: row.attachment_id },
      });
      toast.success(`已刪除附件「${row.file_name}」`);
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">已上傳（{rows.length}）</p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">還沒有附件。</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.attachment_id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3"
              >
                <div className="space-y-0.5">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                    {row.file_name}
                    <Badge variant="outline" className="font-normal">
                      {ATTACHMENT_TYPE_LABELS[row.attachment_type as AttachmentType] ??
                        row.attachment_type}
                    </Badge>
                    {row.attachment_type === "contract" && row.is_current ? (
                      <Badge variant="secondary" className="font-normal">
                        現行版本
                      </Badge>
                    ) : null}
                  </p>
                  {row.attachment_type === "contract" ? (
                    <p className="text-xs text-muted-foreground">
                      {row.contract_start_date ?? "—"} ~ {row.contract_end_date ?? "—"}
                      {row.contract_version ? `・版本 ${row.contract_version}` : ""}
                    </p>
                  ) : null}
                  {row.description ? (
                    <p className="text-xs text-muted-foreground">{row.description}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {row.uploaded_by_name ?? "未知上傳者"}・
                    {new Date(row.created_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || busy || openingId === row.attachment_id}
                    onClick={() => void view(row)}
                  >
                    {openingId === row.attachment_id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "檢視"
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10"
                    disabled={disabled || busy}
                    onClick={() => void remove(row)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Separator />

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
            onClick={() => void upload()}
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
    </div>
  );
}

function ChildPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
