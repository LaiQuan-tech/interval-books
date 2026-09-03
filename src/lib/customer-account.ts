/**
 * 客人帳號前台頁面共用的型別與驗證規則。
 *
 * 與 checkout.ts 同一個角色：這裡放的是瀏覽器也安全看到的型別／schema；真正的
 * server function 包裝在 customer-fns.ts，實際的認證／授權邏輯在
 * src/server/customer-auth.ts 與 src/server/customer-auth-links.ts。
 *
 * 這裡的 schema 同時餵給兩邊：react-hook-form 的 zodResolver（瀏覽器）與
 * createServerFn 的 inputValidator（伺服器）。與 lib/admin/schemas.ts 的
 * vendorSignInSchema 那組不同——那邊刻意在頁面裡另外抄一份給人看的訊息，理由是
 * 「server 那一份的訊息是給 API 看的」；這裡不重複抄一份，因為這幾句訊息從一開始
 * 就是寫給客人看的，沒有第二種更「API」的版本可言。
 */
import { z } from "zod";

/** 與 Supabase 專案設定的 password_min_length=8 對齊（見任務「已知」）。 */
export const CUSTOMER_PASSWORD_MIN = 8;

const customerEmailSchema = z
  .string()
  .trim()
  .min(1, "請輸入電子郵件")
  .email("電子郵件格式不正確")
  .max(200);

const customerNewPasswordSchema = z
  .string()
  .min(CUSTOMER_PASSWORD_MIN, `密碼至少需要 ${CUSTOMER_PASSWORD_MIN} 個字元`)
  .max(200, "密碼太長了");

export const customerSignUpSchema = z.object({
  email: customerEmailSchema,
  password: customerNewPasswordSchema,
});
export type CustomerSignUpInput = z.infer<typeof customerSignUpSchema>;

export const customerSignInSchema = z.object({
  email: customerEmailSchema,
  // 登入不用新密碼規則——舊帳號的密碼可能是在規則收緊之前設的，登入本身不該因為
  // 「太短」被擋，那是 GoTrue 自己驗密碼對不對的事。
  password: z.string().min(1, "請輸入密碼").max(200),
});
export type CustomerSignInInput = z.infer<typeof customerSignInSchema>;

export const customerForgotPasswordSchema = z.object({
  email: customerEmailSchema,
});
export type CustomerForgotPasswordInput = z.infer<typeof customerForgotPasswordSchema>;

export const customerResetPasswordSchema = z.object({
  newPassword: customerNewPasswordSchema,
});
export type CustomerResetPasswordInput = z.infer<typeof customerResetPasswordSchema>;

/**
 * /auth/confirm 用。type 只收這個站真的會產生的兩種——見
 * server/customer-auth-links.ts 的 ConfirmLinkType 檔頭同一條理由。
 */
export const confirmAuthLinkSchema = z.object({
  tokenHash: z.string().trim().min(1, "缺少驗證參數"),
  type: z.enum(["signup", "recovery"]),
});
export type ConfirmAuthLinkInput = z.infer<typeof confirmAuthLinkSchema>;
