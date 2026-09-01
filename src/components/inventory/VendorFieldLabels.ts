/**
 * 廠商表單的值域型別與中文標籤。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。放在同一個檔案裡
 * 的理由是：這些標籤被四個分頁與附件子表分頭用到，跟著任何一個分頁走都會讓另外三個
 * 反向 import。
 */
// schemas.ts 只 export 了 entity_type 與 status 的標籤（那兩個清單頁也要用），
// 下面五個是只有這張表單需要的，所以留在這裡。⚠️ 值域以 schemas.ts 的 const 陣列
// 為準，這裡只補中文 —— 少一個 key 會被 TypeScript 的 Record<> 抓出來。
import {
  VENDOR_ATTACHMENT_TYPES,
  VENDOR_EINVOICE_TYPES,
  VENDOR_ENTITY_TYPES,
  VENDOR_PAYMENT_TERMS,
  VENDOR_RESIDENCY_STATUSES,
  VENDOR_SETTLEMENT_TYPES,
  VENDOR_STATUSES,
  VENDOR_VOUCHER_CATEGORIES,
} from "@/lib/admin/schemas";
// 為準，這裡只補中文 —— 少一個 key 會被 TypeScript 的 Record<> 抓出來。

export type EntityType = (typeof VENDOR_ENTITY_TYPES)[number];
export type VendorStatus = (typeof VENDOR_STATUSES)[number];
export type VoucherCategory = (typeof VENDOR_VOUCHER_CATEGORIES)[number];
export type EinvoiceType = (typeof VENDOR_EINVOICE_TYPES)[number];
export type PaymentTerms = (typeof VENDOR_PAYMENT_TERMS)[number];
export type SettlementType = (typeof VENDOR_SETTLEMENT_TYPES)[number];
export type ResidencyStatus = (typeof VENDOR_RESIDENCY_STATUSES)[number];
export type AttachmentType = (typeof VENDOR_ATTACHMENT_TYPES)[number];

export const VOUCHER_LABELS: Record<VoucherCategory, string> = {
  invoice: "統一發票",
  receipt: "收據",
  official_document: "公文",
  labor_payment: "勞務報酬單",
  none: "無憑證",
};

export const EINVOICE_LABELS: Record<EinvoiceType, string> = {
  none: "不開立",
  b2b: "B2B（三聯式）",
  b2c: "B2C（二聯式）",
};

export const PAYMENT_TERMS_LABELS: Record<PaymentTerms, string> = {
  immediate: "即期付款",
  monthly: "月結",
  negotiated: "另行議定",
};

export const SETTLEMENT_LABELS: Record<SettlementType, string> = {
  invoice_date: "依發票日結算",
  end_of_month: "月底結算",
  monthly: "月結",
};

export const RESIDENCY_LABELS: Record<ResidencyStatus, string> = {
  over_183: "在台居留滿 183 天",
  under_183: "在台居留未滿 183 天",
};

export const ATTACHMENT_TYPE_LABELS: Record<AttachmentType, string> = {
  general: "一般附件",
  contract: "合約",
};

/** Radix Select 不收空字串當 value，所以「不指定」用哨兵值（與 VendorSelect 同一條）。 */
export const NONE = "__none__";

// ---------------------------------------------------------------------------
// 識別碼
// ---------------------------------------------------------------------------
// ⚠️ 這四個欄位在 inv.vendors 裡是 PII，view 只送遮罩出來。哪一個是必填由 entity_type
//    決定，而「畫不畫」還要加上「這家已經有值」那一條 —— 見 VendorIdentitySection。

export const SENSITIVE_KEYS = [
  "tax_id",
  "id_number",
  "foreign_id",
  "residence_permit_number",
] as const;
export type SensitiveKey = (typeof SENSITIVE_KEYS)[number];

export const SENSITIVE_LABELS: Record<SensitiveKey, string> = {
  tax_id: "統一編號",
  id_number: "身分證字號",
  foreign_id: "國外識別碼",
  residence_permit_number: "居留證號碼",
};
