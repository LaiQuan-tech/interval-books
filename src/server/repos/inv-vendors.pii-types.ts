/**
 * 編譯期的 PII 型別斷言。**這個檔案沒有任何執行期程式碼**，只有型別。
 *
 * ── 為什麼需要它 ──────────────────────────────────────────────────────────
 *
 * 這一期的規矩是「沒有任何一個 view 送得出完整號碼」（0019 §3、repos/inv-vendors.ts
 * §1）。SQL 那一側有 migration 的自檢守著；**TypeScript 這一側需要一個對等的守門
 * 人**，因為型別正是「哪些欄位會流到前端」最先被讀到的那份文件。
 *
 * 兩種退化各自要擋：
 *
 *   a. **型別悄悄變成 any。** `.rpc()` 與 loader 的回傳型別只要有一環斷掉，下游
 *      全部變 any —— 那時候 `product.id_number` 會編得過，而且沒有人會發現。
 *      IsAny<T> 把它變成編譯錯誤。
 *   b. **有人「順手」把原始欄位加回型別。** 下面五行讓 AdminVendorDetail 只要多
 *      出 tax_id / id_number / foreign_id / residence_permit_number，或
 *      AdminVendorBankAccount 多出 account_number，`npx tsc --noEmit` 立刻紅。
 *
 * ⚠️ 最後三行是**對照組**：遮罩欄位與 approval_status 必須存在。少了它們，上面那
 *    幾條就只是在驗證「型別是空的」——那是一種通過方式，但不是我們要的那種。
 *
 * ⚠️ 不要 import 這個檔案。它不被任何東西引用是刻意的：沒有 import 就不進 bundle，
 *    而 `tsconfig.json` 的 include 涵蓋整個 src 目錄下的 .ts，所以 tsc 每次都會
 *    檢查它 —— 「不進 bundle」與「不被檢查」是兩件事。
 */
import type {
  AdminVendorBankAccount,
  AdminVendorDetail,
  AdminVendorRow,
  VendorPortalProduct,
  VendorSensitiveResult,
  VendorSubmissionRow,
} from "@/server/repos/inv-vendors";

/** `0 extends 1 & T` 只有在 T 是 any 的時候成立 —— 這是偵測 any 的標準寫法。 */
type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertFalse<T extends false> = T;
type AssertTrue<T extends true> = T;
type HasKey<T, K extends string> = K extends keyof T ? true : false;

// ── (a) 六個型別都不是 any ────────────────────────────────────────────────
type NotAnyPortalProduct = AssertFalse<IsAny<VendorPortalProduct>>;
type NotAnyVendorDetail = AssertFalse<IsAny<AdminVendorDetail>>;
type NotAnyBankAccount = AssertFalse<IsAny<AdminVendorBankAccount>>;
type NotAnySensitive = AssertFalse<IsAny<VendorSensitiveResult>>;
type NotAnyVendorRow = AssertFalse<IsAny<AdminVendorRow>>;
type NotAnySubmission = AssertFalse<IsAny<VendorSubmissionRow>>;

// ── (b) 日常型別上沒有任何原始識別碼 ──────────────────────────────────────
//
// ⚠️ VendorSensitiveResult **不在**這份清單裡，而且不該在：那一支就是唯一被允許
//    帶原值的出口（0019 §4），它的 values.tax_id 存在是正確的。
type DetailHasNoTaxId = AssertFalse<HasKey<AdminVendorDetail, "tax_id">>;
type DetailHasNoIdNumber = AssertFalse<HasKey<AdminVendorDetail, "id_number">>;
type DetailHasNoForeignId = AssertFalse<HasKey<AdminVendorDetail, "foreign_id">>;
type DetailHasNoPermit = AssertFalse<HasKey<AdminVendorDetail, "residence_permit_number">>;
type BankHasNoAccountNumber = AssertFalse<HasKey<AdminVendorBankAccount, "account_number">>;
type ListHasNoTaxId = AssertFalse<HasKey<AdminVendorRow, "tax_id">>;
type ListHasNoIdNumber = AssertFalse<HasKey<AdminVendorRow, "id_number">>;

/** 成本是店家的資訊，不該出現在廠商入口的商品型別上（0019 §7.7）。 */
type PortalProductHasNoCost = AssertFalse<HasKey<VendorPortalProduct, "cost_price">>;

// ── 對照組：遮罩欄位必須在，否則上面那幾條只是在驗證「型別是空的」──────────
type DetailHasMaskedTaxId = AssertTrue<HasKey<AdminVendorDetail, "tax_id_masked">>;
type BankHasMaskedAccount = AssertTrue<HasKey<AdminVendorBankAccount, "account_number_masked">>;
type PortalProductHasStatus = AssertTrue<HasKey<VendorPortalProduct, "approval_status">>;

export type {
  NotAnyPortalProduct,
  NotAnyVendorDetail,
  NotAnyBankAccount,
  NotAnySensitive,
  NotAnyVendorRow,
  NotAnySubmission,
  DetailHasNoTaxId,
  DetailHasNoIdNumber,
  DetailHasNoForeignId,
  DetailHasNoPermit,
  BankHasNoAccountNumber,
  ListHasNoTaxId,
  ListHasNoIdNumber,
  PortalProductHasNoCost,
  DetailHasMaskedTaxId,
  BankHasMaskedAccount,
  PortalProductHasStatus,
};
