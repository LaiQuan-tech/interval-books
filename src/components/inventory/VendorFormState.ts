/**
 * 廠商表單的狀態型別、預設值，以及「detail ⇄ 表單 ⇄ payload」的兩個方向。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。
 *
 * ⚠️ **費率：資料庫存 0–1 的小數，畫面填百分比。** DB 的 cash_fee_rate 預設是 0.08，
 *    店員腦裡的數字是「8%」。轉換就在這個檔案裡（rateToPercent / percentToRate），
 *    vendorSchema 收的是小數，`inv.assert_rate()` 也是用 0–1 檢查。兩邊各守一次，中間
 *    這一層負責翻譯。乘除 100 之後有做 toFixed 收尾，因為 0.1115 × 100 在 IEEE 754 下
 *    會變成 11.150000000000002。
 *
 * ⚠️ formFromDetail **刻意不填四個識別碼**。detail 上只有 *_masked，把遮罩填進表單、
 *    再讓人按一次儲存，`inv_save_vendor()` 的 UPDATE 就會把 `****5678` 這串字真的寫進
 *    tax_id 欄位，而且沒有任何一層會報錯。理由見 VendorIdentityField 的檔頭。
 *
 * ⚠️ toVendorPayload 裡**沒有** approval_status / approved_by / created_by /
 *    vendor_code。四個都由資料庫決定（0019 §5.1）。來源系統是在瀏覽器算完
 *    approval_status 再連同 insert 送出去，於是「要不要審核」變成前端說了算。
 */
import {
  VENDOR_EINVOICE_TYPES,
  VENDOR_ENTITY_TYPES,
  VENDOR_PAYMENT_TERMS,
  VENDOR_RESIDENCY_STATUSES,
  VENDOR_SETTLEMENT_TYPES,
  VENDOR_STATUSES,
  VENDOR_VOUCHER_CATEGORIES,
} from "@/lib/admin/schemas";
import type {
  EinvoiceType,
  EntityType,
  PaymentTerms,
  ResidencyStatus,
  SettlementType,
  VendorStatus,
  VoucherCategory,
} from "@/components/inventory/VendorFieldLabels";
import type { AdminVendorDetail } from "@/server/repos/inv-vendors";
import {
  intOrNull,
  nz,
  percentToRate,
  rateToPercent,
} from "@/components/inventory/VendorFormParsers";

// ---------------------------------------------------------------------------
// 表單狀態
// ---------------------------------------------------------------------------

export type FormState = {
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
export const EMPTY_FORM: FormState = {
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

export function formFromDetail(detail: AdminVendorDetail): FormState {
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

/**
 * 表單 → vendorSchema 的 payload。
 *
 * 空字串一律變成 null（nz），三個「日」是整數欄位（intOrNull），四個費率從百分比換回
 * 0–1 小數（percentToRate）。這裡不做任何驗證 —— 驗證是 vendorSchema 與
 * inv_save_vendor() 的事，這一層只負責換形狀。
 */
export function toVendorPayload(form: FormState, vendorId: string | null) {
  return {
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
  };
}
