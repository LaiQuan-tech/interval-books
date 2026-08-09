/**
 * Admin authentication.
 *
 * Password verification is delegated to Supabase Auth (so we never store or
 * compare password hashes ourselves), but authorization is ours: a valid
 * Supabase account proves identity, not access. Only a profiles row with
 * role='admin' gets in.
 *
 * Accounts are created by hand in the Supabase dashboard — there is no public
 * sign-up, and nothing here creates users.
 */
import "@tanstack/react-start/server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./env";
import { supabaseAdmin } from "./supabase-admin";
import {
  destroyAdminSession,
  readAdminSession,
  writeAdminSession,
  type AdminSessionData,
} from "./session";

/** Thrown when a caller is not a signed-in admin. Callers map this to a 401. */
export class NotAuthorizedError extends Error {
  constructor(message = "需要管理員權限") {
    super(message);
    this.name = "NotAuthorizedError";
  }
}

/**
 * Anon-key client used purely to verify a password. The service role key cannot
 * do this — it bypasses auth rather than performing it. persistSession is off
 * because this client is per-call and must not touch any shared storage.
 */
function authClient() {
  return createClient(supabaseUrl(), import.meta.env.VITE_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/** Looks up the profiles row. Returns null when absent or not an admin. */
async function loadAdminProfile(userId: string) {
  const { data, error } = await supabaseAdmin()
    .from("profiles")
    .select("id, email, role")
    .eq("id", userId)
    .maybeSingle();

  // Fail closed: a lookup error must never be read as "probably fine".
  if (error) throw new Error(`無法讀取管理員資料：${error.message}`);
  if (!data || data.role !== "admin") return null;
  return data;
}

/**
 * Verifies credentials and, if the account is an admin, issues the session
 * cookie. The error message is deliberately identical for "wrong password" and
 * "not an admin" so it cannot be used to enumerate which accounts exist.
 */
export async function signInAdmin(email: string, password: string): Promise<AdminSessionData> {
  const { data, error } = await authClient().auth.signInWithPassword({ email, password });

  if (error || !data.user) throw new NotAuthorizedError("電子郵件或密碼不正確");

  const profile = await loadAdminProfile(data.user.id);
  if (!profile) throw new NotAuthorizedError("電子郵件或密碼不正確");

  const session: AdminSessionData = { userId: data.user.id, email: data.user.email ?? email };
  await writeAdminSession(session);
  return session;
}

export async function signOutAdmin(): Promise<void> {
  await destroyAdminSession();
}

/**
 * The authorization boundary. Every admin server function must run this before
 * touching the service role client — route guards only hide UI and cannot stop
 * a direct POST to /_serverFn/…
 *
 * Re-reads profiles on every call so revoking `role` takes effect on the next
 * request rather than whenever the cookie happens to expire.
 */
export async function requireAdmin() {
  const session = await readAdminSession();
  if (!session) throw new NotAuthorizedError();

  const profile = await loadAdminProfile(session.userId);
  if (!profile) {
    // Cookie is cryptographically valid but access was revoked — drop it so the
    // browser stops presenting it.
    await destroyAdminSession();
    throw new NotAuthorizedError();
  }

  return { userId: profile.id, email: profile.email ?? session.email };
}

/** Non-throwing variant for UI concerns (nav state, redirect decisions). */
export async function getAdminOrNull() {
  try {
    return await requireAdmin();
  } catch {
    return null;
  }
}
