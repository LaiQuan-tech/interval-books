/**
 * Admin session cookie.
 *
 * We do not use @supabase/ssr. Its job is to keep a Supabase JWT available to
 * the browser so client-side queries can satisfy RLS — but every admin write
 * here goes through the service role from a server function, so that JWT would
 * have no consumer. Supabase Auth is used only to verify the password once
 * (see auth.ts); after that we issue our own sealed cookie.
 *
 * Trade-off: disabling a user in the Supabase dashboard does NOT invalidate an
 * already-issued cookie. That is why requireAdmin() re-reads the profiles row
 * on every call — `profiles.role` is the real kill switch, and the short maxAge
 * bounds how long a stale cookie can linger.
 */
import "@tanstack/react-start/server-only";
import {
  clearSession,
  getSession,
  updateSession,
  type SessionConfig,
} from "@tanstack/react-start/server";
import { adminSessionSecret } from "./env";

export type AdminSessionData = {
  /** auth.users.id — the profiles row is looked up fresh on every request. */
  userId: string;
  email: string;
};

/** 8 hours: long enough for a working day, short enough to bound a stale cookie. */
const MAX_AGE_SECONDS = 8 * 60 * 60;

function sessionConfig(): SessionConfig {
  return {
    password: adminSessionSecret(),
    name: "ib_admin",
    maxAge: MAX_AGE_SECONDS,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // Vite dev serves over plain http; Vercel is always https.
      secure: process.env.NODE_ENV === "production",
    },
  };
}

export async function readAdminSession(): Promise<AdminSessionData | null> {
  const session = await getSession<AdminSessionData>(sessionConfig());
  const { userId, email } = session.data;
  if (!userId || !email) return null;
  return { userId, email };
}

export async function writeAdminSession(data: AdminSessionData): Promise<void> {
  await updateSession<AdminSessionData>(sessionConfig(), data);
}

export async function destroyAdminSession(): Promise<void> {
  await clearSession(sessionConfig());
}
