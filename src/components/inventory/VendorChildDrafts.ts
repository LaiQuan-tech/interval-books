/**
 * 三張廠商子表（聯絡人／匯款帳戶／附件）的草稿型別與「新增」預設值。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。三個都被「清單那半邊」
 * 與「表單那半邊」共用：清單負責開草稿（EMPTY_* 或從既有列帶入），表單負責改草稿。
 * 放在沒有元件的 .ts 裡，兩邊就不必互相 import。
 *
 * ⚠️ BankDraft 的 account_number 從既有列帶入時**永遠留空**，只帶 masked —— 把遮罩帶進
 *    草稿再存回去等於毀掉那個帳號。理由見 VendorIdentityField 的檔頭。
 */
import type { AttachmentType } from "@/components/inventory/VendorFieldLabels";

export type ContactDraft = {
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

export const EMPTY_CONTACT: ContactDraft = {
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
export type BankDraft = {
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

export const EMPTY_BANK: BankDraft = {
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
export type AttachmentDraft = {
  file: File | null;
  file_name: string;
  description: string;
  attachment_type: AttachmentType;
  contract_start_date: string;
  contract_end_date: string;
  contract_version: string;
  is_current: boolean;
};

export const EMPTY_ATTACHMENT: AttachmentDraft = {
  file: null,
  file_name: "",
  description: "",
  attachment_type: "general",
  contract_start_date: "",
  contract_end_date: "",
  contract_version: "",
  is_current: true,
};
