/**
 * 進貨表單的狀態形狀。與 product-form-state.ts 同一個做法（也同一個理由：
 * react-refresh 的規矩是一個檔案不要同時 export 元件與常數）。
 *
 * 數字欄位全部是 string —— 受控 input 的值本來就是字串，在這一層就轉成數字的話
 * 「使用者正在打字、目前是空字串」會變成 NaN 或 0。轉型統一在送出前做一次（見
 * PurchaseFormDialog 的 submit()），而且轉完馬上過 zod。
 */
import type { VendorValue } from "@/components/inventory/VendorSelect";

export type PurchaseFormState = {
  product_id: string;
  item_name: string;
  purchase_date: string;
  quantity: string;
  unit_cost: string;
  /** vendor_id 與自由文字互斥，兩個值一起搬（見 VendorSelect 的檔頭）。 */
  vendor: VendorValue;
  publisher: string;
  notes: string;
  expiry_date: string;
  expiry_alert_days: string;
};

export const EMPTY_PURCHASE_FORM: PurchaseFormState = {
  product_id: "",
  item_name: "",
  purchase_date: "",
  quantity: "1",
  unit_cost: "",
  vendor: { vendor_id: null, vendor: null },
  publisher: "",
  notes: "",
  expiry_date: "",
  expiry_alert_days: "",
};
