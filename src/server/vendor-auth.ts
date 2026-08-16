/**
 * 廠商自助入口的認證與授權。
 *
 * ── 為什麼是一支獨立的檔案，而不是在 auth.ts 裡多一個 role ────────────────
 *
 * auth.ts 的兩道門（requireAdmin / requireStaff）守的是**後台**：那些人是內部
 * 同事，看得到的東西差別在「多」與「少」。廠商不是同事 —— 他看得到的東西差別
 * 在「是誰的」。那是另一種問題，混在同一支函式裡遲早會寫成
 * `if (role === 'vendor') { ...另一整套邏輯... }`，然後某一天有人在那個 if 外面
 * 加了一行。
 *
 * 所以這一側從 cookie 開始就是分開的：
 *
 *     後台   cookie `ib_admin`   → readAdminSession()  → profiles.role in (admin, staff)
 *     廠商   cookie `ib_vendor`  → readVendorSession() → profiles.role = 'vendor'
 *                                                      + public.vendor_users
 *
 * 兩個 cookie 名字不同，所以一張後台的 cookie 送到廠商入口會**讀不到**（
 * getSession 是按名字取的），反之亦然。payload 裡另外存一個 kind='vendor' 再驗
 * 一次，是為了萬一哪天有人把兩邊的 name 寫成一樣時仍然擋得住。
 *
 * ── 這一層的核心規矩：vendor_id 永遠來自這裡 ──────────────────────────────
 *
 * requireVendor() 回傳的 vendorId 是**唯一**合法的 vendor_id 來源。每一支廠商可
 * 呼叫的 server fn 都從 context.vendor.vendorId 拿，**沒有任何一支的
 * inputValidator 收 vendorId**。
 *
 * 而且這件事在資料庫層還有第二道門：0019 §7 的每一支函式簽名都**沒有
 * p_vendor_id 參數**，vendor_id 是函式體內用 p_user_id 查 public.vendor_users
 * 得到的。也就是說，就算這一層被寫壞了，資料庫仍然只會回那個 user 自己那一家的
 * 資料 —— 見 repos/inv-vendors.ts 檔頭 §3。
 *
 * ── 與 requireStaff 共用的一條規矩：每次都重讀 ────────────────────────────
 *
 * cookie 是身分，權限每次都要重問。三個開關任何一個關掉，下一個請求就該被擋：
 *
 *     profiles.role          從 vendor 改掉        → 擋
 *     vendor_users.is_active 設成 false            → 擋
 *     inv.vendors.status     改成 suspended/inactive → 擋
 *
 * 最後兩個由 public.vendor_my_id() 在資料庫裡一起判斷（0019 §7.4），所以這裡不
 * 重寫那段邏輯 —— 兩個地方各寫一份判斷，遲早會有一份忘記更新。
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

export type VendorSessionData = {
  /** auth.users.id。vendor_users 那一列每個請求都重查。 */
  userId: string;
  email: string;
  /** 固定是 'vendor'。與 cookie 名字不同是兩道獨立的門，見檔頭。 */
  kind: "vendor";
};

/** 與後台一樣 8 小時。廠商不是每天登入的人，但更長的 cookie 只會讓失效更慢。 */
const MAX_AGE_SECONDS = 8 * 60 * 60;

function vendorSessionConfig(): SessionConfig {
  return {
    password: adminSessionSecret(),
    // ⚠️ 名字**必須**與 session.ts 的 'ib_admin' 不同。同名的話，一張店員的
    //    cookie 會在這裡被讀成一個合法的 session payload。
    name: "ib_vendor",
    maxAge: MAX_AGE_SECONDS,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
    },
  };
}

export async function readVendorSession(): Promise<VendorSessionData | null> {
  const session = await getSession<VendorSessionData>(vendorSessionConfig());
  const { userId, email, kind } = session.data;
  // kind 是第二道門：cookie 名字已經隔開了，這一行擋的是「哪天有人把名字改成一樣」。
  if (!userId || !email || kind !== "vendor") return null;
  return { userId, email, kind: "vendor" };
}

export async function writeVendorSession(data: Omit<VendorSessionData, "kind">): Promise<void> {
  await updateSession<VendorSessionData>(vendorSessionConfig(), { ...data, kind: "vendor" });
}

export async function destroyVendorSession(): Promise<void> {
  await clearSession(vendorSessionConfig());
}

/** 只用來驗密碼的 anon client（與 auth.ts#authClient 同一條理由與同一組選項）。 */
function authClient() {
  return createClient(supabaseUrl(), import.meta.env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type VendorUser = {
  userId: string;
  email: string;
  /** 這個帳號代表哪一家。**唯一**合法的 vendor_id 來源。 */
  vendorId: string;
  vendorName: string;
  vendorCode: string | null;
};

/**
 * 查 profiles.role 是不是 vendor。
 *
 * 與 loadBackOfficeProfile 分開是刻意的：那一支對 role='vendor' 回 null（0010 起
 * 「能不能登入後台」與「能做什麼」是兩個問題），這一支只認 vendor。兩支各自
 * fail-closed，沒有一支需要知道另一支的存在。
 */
async function loadVendorProfile(userId: string) {
  const { data, error } = await supabaseAdmin()
    .from("profiles")
    .select("id, email, role")
    .eq("id", userId)
    .maybeSingle();

  // Fail closed：查詢失敗不可以被讀成「應該沒問題」。
  if (error) throw new Error(`無法讀取廠商帳號：${error.message}`);
  if (!data || data.role !== "vendor") return null;
  return data;
}

/**
 * 驗密碼並發 cookie。
 *
 * ⚠️ 「密碼錯」與「這個帳號不是廠商」用**同一句**錯誤訊息（與 signInAdmin 同一條
 *    理由）：不同的訊息可以拿來列舉哪些 email 存在。
 *
 * ⚠️ 這裡只驗到 role='vendor' 就發 cookie，**不驗 vendor_users**。理由與後台的
 *    pending 一樣：帳號建好了但還沒綁廠商（或被停權）時，他該看到一頁說明，而
 *    不是一個「密碼錯誤」。真正的授權在 requireVendor()。
 */
export async function signInVendor(
  email: string,
  password: string,
): Promise<{ userId: string; email: string }> {
  const { data, error } = await authClient().auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new NotAuthorizedError("電子郵件或密碼不正確");

  const profile = await loadVendorProfile(data.user.id);
  if (!profile) throw new NotAuthorizedError("電子郵件或密碼不正確");

  const session = { userId: data.user.id, email: data.user.email ?? email };
  await writeVendorSession(session);
  return session;
}

export async function signOutVendor(): Promise<void> {
  await destroyVendorSession();
}

/**
 * 廠商入口的授權邊界。**每一支**廠商 server fn 都要跑這個。
 *
 * 三個檢查，缺一不可：
 *   1. cookie 有效（sealed，httpOnly）
 *   2. profiles.role 還是 vendor（撤掉就立刻擋，不等 cookie 過期）
 *   3. public.vendor_my_id() 給得出 vendor_id —— 那一支同時檢查
 *      vendor_users.is_active、vendors.status='active'、approval_status='approved'
 *
 * 第 3 步刻意呼叫資料庫函式而不是在這裡自己查表：那段判斷有三個條件，寫兩份
 * 遲早會有一份忘記更新，而「忘記更新的那一份剛好是比較鬆的那一份」是這一類 bug
 * 的標準結局。
 */
export async function requireVendor(): Promise<VendorUser> {
  const session = await readVendorSession();
  if (!session) throw new NotAuthorizedError("請先登入廠商入口");

  const profile = await loadVendorProfile(session.userId);
  if (!profile) {
    // cookie 在密碼學上有效，但身分已經被撤掉 —— 丟掉它，別讓瀏覽器繼續拿它敲門。
    await destroyVendorSession();
    throw new NotAuthorizedError("請先登入廠商入口");
  }

  const { data, error } = await supabaseAdmin().rpc("vendor_my_id", { p_user_id: session.userId });

  if (error) {
    // 0019 §7.4 對「沒綁定／被停權／廠商已終止往來」刻意共用同一句話，這裡原樣
    // 轉出去。錯誤訊息可以拿來反查「這個帳號有沒有綁定」就是一個列舉管道。
    if (error.message.includes("VENDOR_PORTAL_NOT_LINKED")) {
      throw new NotAuthorizedError("這個帳號目前沒有可用的廠商入口權限，請聯絡書店");
    }
    throw new Error(`無法確認廠商身分：${error.message}`);
  }

  const vendorId = data as unknown as string | null;
  if (!vendorId) throw new NotAuthorizedError("這個帳號目前沒有可用的廠商入口權限，請聯絡書店");

  // 名稱只是拿來顯示在畫面上。授權已經在上面做完了。
  const { data: vendor, error: vendorError } = await supabaseAdmin()
    .from("inv_admin_vendor_list")
    .select("vendor_id, name, vendor_code")
    .eq("vendor_id", vendorId)
    .maybeSingle();

  if (vendorError) throw new Error(`無法讀取廠商資料：${vendorError.message}`);

  return {
    userId: profile.id,
    email: profile.email ?? session.email,
    vendorId,
    vendorName: vendor?.name ?? "",
    vendorCode: vendor?.vendor_code ?? null,
  };
}

/** 不丟例外的版本，給 /vendor 的 route guard 決定要導去哪裡用。 */
export async function getVendorOrNull(): Promise<VendorUser | null> {
  try {
    return await requireVendor();
  } catch {
    return null;
  }
}

/**
 * 已登入但還沒綁廠商（或被停權）的人。
 *
 * 與 getVendorOrNull() 分開，理由與後台的 PendingApprovalError 一樣：「你不該在
 * 這裡」與「等一下」是兩件事。混成同一個 401，廠商只會一直重試登入然後打電話
 * 問為什麼帳號壞了。
 */
export async function getVendorSessionOrNull(): Promise<{ userId: string; email: string } | null> {
  const session = await readVendorSession();
  if (!session) return null;
  try {
    const profile = await loadVendorProfile(session.userId);
    if (!profile) {
      await destroyVendorSession();
      return null;
    }
    return { userId: profile.id, email: profile.email ?? session.email };
  } catch {
    return null;
  }
}
