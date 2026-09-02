/**
 * 客人帳號的認證與授權。
 *
 * ── 為什麼是第三支獨立的檔案 ──────────────────────────────────────────────
 *
 * vendor-auth.ts 的檔頭已經把這個決定講過一次：後台（auth.ts）守的是「同事看得到
 * 多少」，廠商入口守的是「這是誰的」。客人是**第三種外部使用者**，而且是三者裡
 * 數量最多、身分最不受控的一種 —— 任何人都能自己註冊。把他混進前兩支的任何一支，
 * 遲早會寫成 `if (kind === 'customer') { …另一整套邏輯… }`，然後某一天有人在那個
 * if 外面加了一行。
 *
 * 所以三側從 cookie 開始就是分開的：
 *
 *     後台   cookie `ib_admin`     → readAdminSession()    → profiles.role in (admin, staff, pending)
 *     廠商   cookie `ib_vendor`    → readVendorSession()   → profiles.role = 'vendor' + vendor_users
 *     客人   cookie `ib_customer`  → readCustomerSession() → auth.users 還活著且信箱已驗證
 *
 * 三個 cookie 名字互不相同，所以一張後台的 cookie 送到客人這一側會**讀不到**
 * （getSession 是按名字取的），反之亦然。payload 裡另外存一個 kind='customer'
 * 再驗一次，是為了萬一哪天有人把名字寫成一樣時仍然擋得住。
 * scripts/customer-account-selftest.mjs 對這兩個方向各測一次。
 *
 * ── 這一層的核心規矩：userId 永遠來自這裡 ────────────────────────────────
 *
 * requireCustomer() 回傳的 userId 是**唯一**合法的 user_id 來源。每一支客人可
 * 呼叫的 server fn 都從它拿，**沒有任何一支的 inputValidator 收 userId**。
 * 真正的歸屬過濾只寫在 repos/customer-orders.ts 一個檔案裡 —— 那是唯一的授權
 * 邊界，見那支檔頭。
 *
 * ── kill switch 為什麼看 auth.users，不看 profiles.role ──────────────────
 *
 * requireAdmin / requireVendor 每次都重讀 profiles.role，因為那兩側的 role 本身
 * 就是開關（admin → customer 就進不去了）。客人這一側沒有這種東西：
 * profiles.role 的值域是 customer/pending/staff/vendor/admin（0010），裡面**沒有
 * 一個值代表「這個客人被停權了」**，而 'customer' 又是新註冊的預設值
 * （0002 的 handle_new_user() 只寫 id + email，不覆蓋預設）。
 *
 * 而且門市的店員、老闆自己都會在自己店裡買書。要求 role 必須恰好是 'customer'
 * 會讓他們看不到自己的訂單，那不是安全，那是壞掉。
 *
 * 客人這一側真正的開關是 **auth.users**：停權＝停用或刪除那個帳號。所以
 * requireCustomer() 每次都重讀它，而且驗的三件事與 0030 的
 * claim_guest_orders() 三道閘裡的前兩道**是同一組條件**：
 *
 *     帳號還在（getUserById 查得到）
 *     email_confirmed_at is not null
 *     banned_until 沒有生效 / deleted_at is null
 *
 * 「能認領訂單」與「能讀訂單」用同一組條件，是刻意的：兩邊分岔的話，會出現一種
 * 帳號讀得到別人早就不該讓他讀的東西，而沒有任何一支測試會問這個問題。
 */
import "@tanstack/react-start/server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./env";
import { supabaseAdmin } from "./supabase-admin";
import { NotAuthorizedError } from "./auth";
import {
  clearSession,
  getSession,
  updateSession,
  type SessionConfig,
} from "@tanstack/react-start/server";
import { adminSessionSecret } from "./env";

/**
 * 密碼是對的，但信箱還沒驗證。
 *
 * 刻意與 NotAuthorizedError 分開，理由與 auth.ts 的 PendingApprovalError 一模一樣：
 * 「你不該在這裡」與「請先去收信」是兩件事。混成同一個「帳號或密碼不正確」，
 * 客人只會一直重打密碼，然後打電話來問為什麼帳號壞了。
 *
 * ⚠️ 這個錯誤**不是**帳號列舉管道。GoTrue 是先驗密碼、密碼對了才回
 *    email_not_confirmed（密碼錯一律回 invalid_credentials），所以拿得到這個
 *    錯誤的人本來就已經知道那組密碼。
 */
export class EmailNotConfirmedError extends Error {
  constructor(message = "請先收信完成信箱驗證，再回來登入") {
    super(message);
    this.name = "EmailNotConfirmedError";
  }
}

export type CustomerSessionData = {
  /** auth.users.id。帳號狀態每個請求都重查。 */
  userId: string;
  email: string;
  /** 固定是 'customer'。與 cookie 名字不同是兩道獨立的門，見檔頭。 */
  kind: "customer";
};

export type CustomerUser = {
  userId: string;
  email: string;
};

/** 與後台、廠商一樣 8 小時。理由見 session.ts：短的 maxAge 界定過期 cookie 能活多久。 */
const MAX_AGE_SECONDS = 8 * 60 * 60;

function customerSessionConfig(): SessionConfig {
  return {
    // ⚠️ 共用 ADMIN_SESSION_SECRET，與 vendor-auth.ts 同一個決定：**不新增環境變數**。
    //    密鑰只負責封緘，區隔身分的是 cookie 名字與 payload 裡的 kind。
    password: adminSessionSecret(),
    // ⚠️ 名字**必須**與 session.ts 的 'ib_admin' 與 vendor-auth.ts 的 'ib_vendor'
    //    都不同。同名的話，一張後台的 cookie 會在這裡被讀成一個合法的 session。
    name: "ib_customer",
    maxAge: MAX_AGE_SECONDS,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // Vite dev 走 http；Vercel 一定是 https。
      secure: process.env.NODE_ENV === "production",
    },
  };
}

export async function readCustomerSession(): Promise<CustomerSessionData | null> {
  const session = await getSession<CustomerSessionData>(customerSessionConfig());
  const { userId, email, kind } = session.data;
  // kind 是第二道門：cookie 名字已經隔開了，這一行擋的是「哪天有人把名字改成一樣」。
  if (!userId || !email || kind !== "customer") return null;
  return { userId, email, kind: "customer" };
}

export async function writeCustomerSession(data: Omit<CustomerSessionData, "kind">): Promise<void> {
  await updateSession<CustomerSessionData>(customerSessionConfig(), { ...data, kind: "customer" });
}

export async function destroyCustomerSession(): Promise<void> {
  await clearSession(customerSessionConfig());
}

/** 只用來驗密碼／註冊的 anon client（與 auth.ts#authClient 同一條理由與同一組選項）。 */
function authClient() {
  return createClient(supabaseUrl(), import.meta.env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// ─────────────────────────── 驗證信要導回哪裡 ───────────────────────────

/**
 * 信箱驗證信／重設密碼信裡那條連結的落點，組不出可用的網址就回 null。
 *
 * ── 🔴 為什麼這裡會回 null，而不是直接組一條出來 ────────────────────────
 *
 * `SITE_URL` **從來沒有設在 Vercel 上**。src/server/blackcat.ts:163-180 記著那次
 * 事故：payuni.ts 與 blackcat.ts 的 siteUrl() 因此退回預設值
 * `http://localhost:8080`，客人刷完卡被導到 localhost、APN 也送到 localhost，
 * 訂單卡在 pending 被排程取消，而錢已經收了（IB-202600001191，NT$1,800）。
 *
 * 驗證信是同一個形狀的陷阱，而且更難發現：一封寄到客人信箱、連結指向
 * localhost 的驗證信，在我們這一側完全沒有任何錯誤 —— 寄出成功、log 乾淨，
 * 只有客人那邊點下去打不開。
 *
 * 所以判準與 blackcatApnUrl() 一樣，不是「哪個環境」而是「客人的瀏覽器連得到嗎」：
 * loopback 位址與非 https 的網址，在正式環境下都不是有效的落點。
 *
 * 組不出來就回 null，呼叫端**整個省略 emailRedirectTo**。那時 GoTrue 會用
 * Supabase 專案自己設定的 Site URL —— 那個值是設定過的、而且一定是對外的網址。
 * 把決定交還給一個設對了的地方，比堅持送出一條我們已經知道是死的網址好。
 *
 * ⚠️ 沒有新增環境變數。SITE_URL 是既有的（payuni.ts:50、blackcat.ts:71 都在讀）。
 *    這裡刻意不從那兩支 import：它們的 siteUrl() 一律回字串、永遠不回 null，
 *    政策不同的東西共用一個名字才是真正會出事的地方。
 */
export function customerAuthRedirectUrl(): string | null {
  const base = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
  if (!base) return null;

  let url: URL;
  try {
    url = new URL(`${base}/auth/confirm`);
  } catch {
    return null;
  }

  // 本機開發（NODE_ENV !== production）放行 http://localhost —— 那時候這條連結
  // 本來就該指回本機。與 session.ts 的 `secure:` 用同一個判準。
  if (process.env.NODE_ENV !== "production") return url.toString();

  if (url.protocol !== "https:") return null;
  if (UNREACHABLE_HOSTS.has(url.hostname) || url.hostname.endsWith(".local")) return null;
  return url.toString();
}

/** 與 blackcat.ts 同一份清單：客人的瀏覽器從外面永遠連不到的主機名。 */
const UNREACHABLE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

// ────────────────────────────── 註冊與登入 ──────────────────────────────

/**
 * 註冊。信箱驗證由 Supabase Auth 負責寄信。
 *
 * ⚠️ 這裡**不**建立 profiles 列，也不設 role：0002 的 handle_new_user() trigger
 *    會在 auth.users insert 之後補上 id + email，而 profiles.role 的預設值就是
 *    'customer'。在這裡再寫一次只會多一個「兩份預設值哪一份才算數」的問題。
 *
 * ⚠️ 回傳值刻意**不透露這個 email 是不是已經註冊過**。Supabase 對已存在的信箱
 *    會回一個內容被抹掉的 user 而不是錯誤（這是它防帳號列舉的設計），這裡原樣
 *    保留：呼叫端一律顯示「驗證信已寄出，請收信」。
 */
export async function signUpCustomer(email: string, password: string): Promise<void> {
  const redirectTo = customerAuthRedirectUrl();
  const { error } = await authClient().auth.signUp({
    email,
    password,
    // null 時整個省略，讓 GoTrue 用專案設定的 Site URL —— 見 customerAuthRedirectUrl()。
    options: redirectTo ? { emailRedirectTo: redirectTo } : undefined,
  });

  if (error) {
    // 密碼太弱、信箱格式不合、寄信頻率超限這幾種，客人改得動，原樣轉出去。
    if (
      error.code === "weak_password" ||
      error.code === "validation_failed" ||
      error.code === "email_address_invalid" ||
      error.code === "over_email_send_rate_limit" ||
      error.code === "over_request_rate_limit"
    ) {
      throw new NotAuthorizedError(error.message);
    }
    throw new Error(`註冊失敗：${error.message}`);
  }
}

/**
 * 驗密碼並發 cookie，順便認領這個信箱底下還沒有主人的訪客訂單。
 *
 * ⚠️ 「密碼錯」與「沒有這個帳號」用**同一句**錯誤訊息（與 signInAdmin /
 *    signInVendor 同一條理由）：不同的訊息可以拿來列舉哪些 email 存在。
 *    信箱未驗證是**唯一**的例外，理由見 EmailNotConfirmedError。
 *
 * ⚠️ Supabase 回來的那張 JWT 在這裡就丟掉，我們發自己的 cookie —— 這是 signInAdmin()
 *    與 signInVendor() 已經在做的事，見 session.ts 檔頭：瀏覽器從來沒有拿過
 *    Supabase JWT，所以那張 token 沒有任何消費者。
 *
 * ⚠️ claim_guest_orders() 失敗**不擋登入**。認領是加分項（沒認領到就是訂單列表少
 *    幾張，客人還是可以用 public_token 那條舊路看單），而登入是他此刻要做的事。
 *    把兩件事綁在一起，等於讓一個非關鍵的 RPC 有權讓整站的客人登不進來。
 *    那一支本身是 no-op-safe 的（三道閘之一是 user_id is null），所以下次登入
 *    會再試一次。
 */
export async function signInCustomer(
  email: string,
  password: string,
): Promise<{ userId: string; email: string; claimedOrders: number }> {
  const { data, error } = await authClient().auth.signInWithPassword({ email, password });

  if (error) {
    // GoTrue 先驗密碼；密碼錯一律是 invalid_credentials。拿得到 email_not_confirmed
    // 的人已經打對了密碼，所以這一句不會變成列舉管道。
    if (error.code === "email_not_confirmed") throw new EmailNotConfirmedError();
    throw new NotAuthorizedError("電子郵件或密碼不正確");
  }
  if (!data.user) throw new NotAuthorizedError("電子郵件或密碼不正確");

  // 防守：專案若把「未驗證也能登入」打開，上面那個錯誤就不會出現。判準要在我們
  // 這一側也存在一份 —— 0030 的閘門 ① 擋的是同一件事，兩邊都擋才不會有一邊被
  // 改掉之後沒人發現。
  if (!data.user.email_confirmed_at) throw new EmailNotConfirmedError();

  const session = { userId: data.user.id, email: data.user.email ?? email };
  await writeCustomerSession(session);

  let claimedOrders = 0;
  try {
    const { data: claimed, error: claimError } = await supabaseAdmin().rpc("claim_guest_orders", {
      p_user_id: session.userId,
    });
    if (!claimError) claimedOrders = Number(claimed ?? 0) || 0;
  } catch {
    // 見上面：認領失敗不擋登入。
  }

  return { ...session, claimedOrders };
}

export async function signOutCustomer(): Promise<void> {
  await destroyCustomerSession();
}

/**
 * 忘記密碼。一律「成功」。
 *
 * ⚠️ 這一支**永遠不會**因為「查無此帳號」而丟例外，而且刻意不回傳任何足以分辨
 *    信箱存不存在的東西。會回報的只有寄信頻率超限（那個資訊與帳號存不存在無關）。
 *    Supabase 的 resetPasswordForEmail 本來就是這個姿態，這裡不要把它拆掉。
 */
export async function requestCustomerPasswordReset(email: string): Promise<void> {
  const redirectTo = customerAuthRedirectUrl();
  const { error } = await authClient().auth.resetPasswordForEmail(
    email,
    redirectTo ? { redirectTo } : undefined,
  );

  if (
    error &&
    (error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit")
  ) {
    throw new NotAuthorizedError("寄送次數過於頻繁，請稍後再試");
  }
  // 其餘錯誤（含查無此人）一律吞掉：見上面。
}

// ──────────────────────────── 授權邊界 ────────────────────────────

/**
 * 客人這一側的授權邊界。**每一支**客人 server fn 都要跑這個。
 *
 * 三個檢查，缺一不可：
 *   1. cookie 有效（sealed、httpOnly）而且 kind === 'customer'
 *   2. auth.users 那個帳號還在（刪掉就立刻擋，不等 cookie 過期）
 *   3. 信箱仍然是已驗證的、帳號沒有被停權／軟刪除
 *
 * 第 2、3 步每次都重讀，與 requireAdmin() / requireVendor() 同一條規矩：
 * cookie 是身分，狀態每次都要重問。
 */
export async function requireCustomer(): Promise<CustomerUser> {
  const session = await readCustomerSession();
  if (!session) throw new NotAuthorizedError("請先登入");

  const { data, error } = await supabaseAdmin().auth.admin.getUserById(session.userId);

  if (error) {
    // 帳號被刪掉 → 404 / user_not_found。cookie 在密碼學上有效但身分已經沒了，
    // 丟掉它，別讓瀏覽器繼續拿它敲門。
    if (error.status === 404 || error.code === "user_not_found") {
      await destroyCustomerSession();
      throw new NotAuthorizedError("請先登入");
    }
    // Fail closed：查詢失敗不可以被讀成「應該沒問題」。**不**銷毀 cookie ——
    // Supabase 抖一下不該把全站的客人登出。
    throw new Error(`無法確認帳號狀態：${error.message}`);
  }

  const user = data?.user;
  if (!user) {
    await destroyCustomerSession();
    throw new NotAuthorizedError("請先登入");
  }

  // 與 0030 claim_guest_orders() 的閘門 ①② 是同一組條件，見檔頭。
  const banned = user.banned_until != null && new Date(user.banned_until).getTime() > Date.now();
  if (!user.email_confirmed_at || user.deleted_at != null || banned) {
    await destroyCustomerSession();
    throw new NotAuthorizedError("請先登入");
  }

  return { userId: user.id, email: user.email ?? session.email };
}

/** 不丟例外的版本，給頁面的 route guard 決定要導去哪裡用。 */
export async function getCustomerOrNull(): Promise<CustomerUser | null> {
  try {
    return await requireCustomer();
  } catch {
    return null;
  }
}
