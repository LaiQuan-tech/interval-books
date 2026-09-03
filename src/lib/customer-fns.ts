/**
 * 客人帳號前台頁面的 server functions。
 *
 * 授權模型見 src/server/customer-auth.ts 檔頭：客人是第三種外部使用者，cookie 是
 * `ib_customer`，與後台 `ib_admin`、廠商 `ib_vendor` 是三扇不同的門，從一開始就
 * 刻意分開。
 *
 * ═══ 這個檔案唯一的規矩 ═══════════════════════════════════════════════════
 *
 * 讀自己訂單／報名的那一支，userId 一律來自 customerFnMiddleware()
 * （= requireCustomer()），**不會**出現在任何 inputValidator 裡。真正的歸屬
 * 過濾寫在 src/server/repos/customer-orders.ts 一個檔案裡——這裡只轉傳
 * context.customer.userId 進去，不繞過去自己 import supabaseAdmin 查
 * orders / event_registrations。scripts/account-pages-selftest.mjs 會掃這個
 * 檔案守住這一條。
 *
 * ── 為什麼 customerFnMiddleware 定義在這裡，不是 lib/admin/middleware.ts ───
 *
 * 那個檔案已經放了 adminFnMiddleware / staffFnMiddleware / vendorFnMiddleware。
 * 客人在型態上與廠商很像（都是「cookie session → requireX()」），但
 * customer-auth.ts 的檔頭花了一整段在講「三側從 cookie 開始就是分開的，混進去
 * 遲早會寫成 if (kind === 'customer') { …另一整套邏輯… }」——那句話對「把客人的
 * middleware 塞進一個檔名叫 admin 的檔案」同樣成立。獨立在這裡，只有這個檔案的
 * server fn 會用到它。
 */
import { createServerFn, createMiddleware } from "@tanstack/react-start";
import {
  customerSignUpSchema,
  customerSignInSchema,
  customerForgotPasswordSchema,
  customerResetPasswordSchema,
  confirmAuthLinkSchema,
} from "@/lib/customer-account";

const customerFnMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  // Imported inside the handler so server-only code never appears in the
  // client module graph — the same pattern as lib/admin/middleware.ts.
  const { requireCustomer } = await import("@/server/customer-auth");
  const customer = await requireCustomer();
  return next({ context: { customer } });
});

// ---------------------------------------------------------------------------
// 註冊／登入／登出
// ---------------------------------------------------------------------------

export const customerSignUp = createServerFn({ method: "POST" })
  .inputValidator(customerSignUpSchema)
  .handler(async ({ data }) => {
    const { signUpCustomer } = await import("@/server/customer-auth");
    await signUpCustomer(data.email, data.password);
    return { ok: true } as const;
  });

export const customerSignIn = createServerFn({ method: "POST" })
  .inputValidator(customerSignInSchema)
  .handler(async ({ data }) => {
    const { signInCustomer } = await import("@/server/customer-auth");
    const result = await signInCustomer(data.email, data.password);
    return { email: result.email, claimedOrders: result.claimedOrders };
  });

/** POST——不接受 GET，否則一個 `<img src="/_serverFn/…">` 就能把人登出。 */
export const customerSignOut = createServerFn({ method: "POST" }).handler(async () => {
  const { signOutCustomer } = await import("@/server/customer-auth");
  await signOutCustomer();
  return { ok: true } as const;
});

/** 給 /account、/account/reset 的 route guard 用。不丟例外，讓呼叫端決定要導去哪裡。 */
export const getCurrentCustomer = createServerFn({ method: "GET" }).handler(async () => {
  const { getCustomerOrNull } = await import("@/server/customer-auth");
  const customer = await getCustomerOrNull();
  if (customer) return { state: "ok" as const, customer };
  return { state: "signed_out" as const };
});

// ---------------------------------------------------------------------------
// 忘記密碼／信件連結
// ---------------------------------------------------------------------------

/**
 * ⚠️ 這一支不論查有查無都回 { ok: true }——真正「不透露帳號存不存在」的邏輯在
 *    requestCustomerPasswordReset() 本人（見那支檔頭），這裡原樣轉傳，不要在這一
 *    層加任何 try/catch 把它變成看得出差異的東西。唯一會讓這支拋例外的是寄送
 *    次數超限，那句訊息本身不透露帳號是否存在，呼叫端可以照樣顯示。
 */
export const requestPasswordReset = createServerFn({ method: "POST" })
  .inputValidator(customerForgotPasswordSchema)
  .handler(async ({ data }) => {
    const { requestCustomerPasswordReset } = await import("@/server/customer-auth");
    await requestCustomerPasswordReset(data.email);
    return { ok: true } as const;
  });

/** /auth/confirm 落地時呼叫一次。token_hash 是一次性的——見 server/customer-auth-links.ts 檔頭。 */
export const confirmAuthLink = createServerFn({ method: "POST" })
  .inputValidator(confirmAuthLinkSchema)
  .handler(async ({ data }) => {
    const { confirmCustomerAuthLink } = await import("@/server/customer-auth-links");
    return await confirmCustomerAuthLink(data.tokenHash, data.type);
  });

/** 已登入客人設定新密碼——忘記密碼流程的最後一步，或帳號頁裡的「修改密碼」。 */
export const setNewPassword = createServerFn({ method: "POST" })
  .middleware([customerFnMiddleware])
  .inputValidator(customerResetPasswordSchema)
  .handler(async ({ data, context }) => {
    const { setCustomerPassword } = await import("@/server/customer-auth-links");
    await setCustomerPassword(context.customer.userId, data.newPassword);
    return { ok: true } as const;
  });

// ---------------------------------------------------------------------------
// 我的帳號：訂單 + 活動報名
// ---------------------------------------------------------------------------

/**
 * account.tsx 用這一支拿齊兩份清單。**沒有參數**——userId 只從
 * context.customer（= requireCustomer()）來，見檔頭。兩份清單各自呼叫
 * server/repos/customer-orders.ts 唯一的歸屬過濾層，這裡不直接碰
 * orders / event_registrations。
 */
export const fetchMyAccountData = createServerFn({ method: "GET" })
  .middleware([customerFnMiddleware])
  .handler(async ({ context }) => {
    const { fetchMyOrders, fetchMyRegistrations } = await import("@/server/repos/customer-orders");
    const [orders, registrations] = await Promise.all([
      fetchMyOrders(context.customer.userId),
      fetchMyRegistrations(context.customer.userId),
    ]);
    return { orders, registrations };
  });
