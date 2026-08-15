/**
 * Auth server functions.
 *
 * signIn and getCurrentAdmin deliberately do NOT chain adminFnMiddleware:
 * that middleware calls requireAdmin(), which throws for anyone not already
 * signed in. Guarding signIn with it would make it impossible to ever sign
 * in (chicken-and-egg), and getCurrentAdmin IS the mechanism the UI uses to
 * find out whether someone is signed in — it has to work when they aren't.
 *
 * signOut is left unguarded too, on purpose: if profiles.role was revoked
 * after a cookie was issued, the cookie is still cryptographically valid
 * (see src/server/session.ts) and the user should still be able to clear it
 * via "登出" without requireAdmin() throwing in the way.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const signInInput = z.object({
  email: z.string().trim().min(1, "請輸入電子郵件").email("電子郵件格式不正確"),
  password: z.string().min(1, "請輸入密碼"),
});

export const signIn = createServerFn({ method: "POST" })
  .inputValidator(signInInput)
  .handler(async ({ data }) => {
    const { signInAdmin } = await import("@/server/auth");
    const session = await signInAdmin(data.email, data.password);
    return { email: session.email, role: session.role };
  });

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
  const { signOutAdmin } = await import("@/server/auth");
  await signOutAdmin();
  return { ok: true };
});

export const getCurrentAdmin = createServerFn({ method: "GET" }).handler(async () => {
  const { getAdminOrNull } = await import("@/server/auth");
  return await getAdminOrNull();
});

/**
 * 誰登入了、是什麼角色、有哪些細權限 —— /admin/_shell 的 beforeLoad 用這支決定
 * 導向哪裡、側欄長什麼樣。
 *
 * ⚠️ 這支的回傳值**不是授權**。它只是畫面用的。真正擋人的是 adminFnMiddleware
 *    與 staffFnMiddleware，而它們各自重讀一次 profiles。
 *
 * 與 getCurrentAdmin 並存而不是取代它：那支的語意（「現在這個人是不是 admin」）
 * 還有既有呼叫端，而且它背後的 requireAdmin() 對非 admin 會銷毀 cookie ——
 * 那對 admin 專用的判斷是對的，對這裡會讓店員一登入就被登出。
 */
export const getCurrentBackOfficeUser = createServerFn({ method: "GET" }).handler(async () => {
  const { getBackOfficeUserOrNull } = await import("@/server/auth");
  return await getBackOfficeUserOrNull();
});
