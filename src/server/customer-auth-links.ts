/**
 * 信件連結（信箱驗證信、忘記密碼信）落地後的處理：token_hash + verifyOtp。
 *
 * ── 為什麼獨立成一個檔案，不寫進 customer-auth.ts ─────────────────────────
 *
 * customer-auth.ts 的檔頭與 scripts/customer-account-selftest.mjs 守的都是同一件
 * 事：「這個人是不是誰」——密碼登入、cookie 的三道閘。verifyOtp 是完全不同的一種
 * 身分證明（持有信件裡的一次性 token），混進同一個檔案只會讓那三道閘旁邊多出一段
 * 跟閘門無關的解析程式碼，而那個檔案已經明講「已經上線、已經驗證，不要重寫」。
 *
 * 這裡只做兩件事，而且都是**借用**、不是重新發明：
 *   1. 驗 token_hash，成功後借用 customer-auth.ts 已經 export 的
 *      writeCustomerSession() 把結果換成同一種 `ib_customer` cookie——不新增
 *      cookie 種類、不新增 session 機制。
 *   2. 已登入客人設定新密碼（走 requireCustomer() 那一道既有的閘門，不是靠
 *      token_hash 第二次）。
 *
 * ── verifyOtp 是一次性的，所以只在落地那一刻用一次 ────────────────────────
 *
 * 同一個 token_hash 第二次呼叫 verifyOtp 一定失敗（GoTrue 的設計）。所以整個
 * 「忘記密碼」流程只在 /auth/confirm 落地那一刻驗一次 token_hash：驗過之後立刻
 * 換成我們自己的 cookie，並把人導去 /account/reset；那一頁要不要設新密碼，靠的
 * 是 requireCustomer()，token_hash 從此不再需要，也不會再被帶去下一個網址——
 * 一次性密鑰不該在多一次 redirect 裡多留一份在瀏覽器歷史紀錄／referrer 裡。
 *
 * ── 信箱驗證信與忘記密碼信共用同一支的理由 ─────────────────────────────────
 *
 * 兩種信都指向 `${siteUrl()}/auth/confirm`（customer-auth.ts 的
 * customerAuthRedirectUrl()，見那支檔頭），差別只在 URL 上的 `type`。驗證信
 * （type=signup）證明的是「這個人現在就是這個信箱的主人」——與密碼登入證明的是
 * 同一件事，所以驗證成功後直接發登入 cookie 是合理的延伸，不是放寬（GoTrue 本身
 * 對 verifyOtp 成功也會回一組有效的 session，這裡只是把那組 session 換成我們自己
 * 的 cookie，做法與 signInCustomer() 把 signInWithPassword() 的 session 換掉完全
 * 一樣，見 customer-auth.ts）。忘記密碼信（type=recovery）證明的也是同一件事，
 * 只是後面多一步：逼他設一組新密碼，而不是讓舊密碼（可能就是他想換掉的那組）
 * 繼續有效。
 */
import "@tanstack/react-start/server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./env";
import { supabaseAdmin } from "./supabase-admin";
import { NotAuthorizedError } from "./auth";
import { writeCustomerSession } from "./customer-auth";

/** 只用來驗 token_hash 的 anon client（與 customer-auth.ts#authClient 同一條理由與同一組選項）。 */
function authClient() {
  return createClient(supabaseUrl(), import.meta.env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * 這個站只會產生這兩種信件連結（見 customer-auth.ts 的 signUpCustomer /
 * requestCustomerPasswordReset）。Supabase 的 EmailOtpType 還有 invite /
 * magiclink / email_change，這裡不收——那幾種流程在這個站不存在，收了也只是
 * 死路，不如在型別層就先擋掉。
 */
export type ConfirmLinkType = "signup" | "recovery";

export type ConfirmLinkResult = {
  email: string;
  /** 告訴呼叫端要把人導去哪裡：signup → /account；recovery → /account/reset。 */
  type: ConfirmLinkType;
};

/**
 * 驗 token_hash，成功就發 `ib_customer` cookie（順便認領訪客訂單，與
 * signInCustomer 同一條理由——見 customer-auth.ts）。
 *
 * ⚠️ 失敗時丟 NotAuthorizedError，訊息刻意不區分「過期」「已經用過」「根本是
 *    亂打的」——GoTrue 對這三種回的都是同一種 400，區分不出來，硬要分只會編造
 *    一個我們自己都不確定是真的的理由。呼叫端（auth.confirm.tsx）把這句話原樣
 *    顯示在一個專屬的說明頁，不導去 /account/login——見那個檔案檔頭。
 */
export async function confirmCustomerAuthLink(
  tokenHash: string,
  type: ConfirmLinkType,
): Promise<ConfirmLinkResult> {
  const { data, error } = await authClient().auth.verifyOtp({ token_hash: tokenHash, type });

  if (error || !data.user) {
    throw new NotAuthorizedError("這個連結無法使用，可能已經過期或已經使用過");
  }

  const email = data.user.email ?? "";
  await writeCustomerSession({ userId: data.user.id, email });

  // 認領訪客訂單：與 signInCustomer 同一條理由，失敗不擋這一支——見
  // customer-auth.ts#signInCustomer 檔頭。這裡不 import 那支函式本身（它還做
  // 密碼驗證，這裡沒有密碼可驗），只重複它認領那一段、同一組參數、同一支 RPC。
  try {
    await supabaseAdmin().rpc("claim_guest_orders", { p_user_id: data.user.id });
  } catch {
    // best-effort，見上面。
  }

  return { email, type };
}

/**
 * 已登入客人設定新密碼——忘記密碼流程的最後一步，或帳號頁裡的「修改密碼」。
 *
 * ⚠️ userId 一律來自呼叫端的 requireCustomer()（見 lib/customer-fns.ts 的
 *    customerFnMiddleware），這裡不重新驗證身分、也不收 token_hash——那一次性
 *    的驗證已經在 confirmCustomerAuthLink() 用掉了，見檔頭。
 */
export async function setCustomerPassword(userId: string, newPassword: string): Promise<void> {
  const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (error) throw new Error(`無法更新密碼：${error.message}`);
}
