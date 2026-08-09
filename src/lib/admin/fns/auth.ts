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
    return { email: session.email };
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
