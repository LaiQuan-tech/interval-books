/**
 * Server-only environment access.
 *
 * IMPORTANT: never name a secret with a `VITE_` prefix. The Vite config
 * (@lovable.dev/vite-tanstack-config) runs `loadEnv(mode, cwd, "VITE_")` and
 * turns every match into a compile-time `define` — applied to BOTH the client
 * and the SSR bundle. A `VITE_`-prefixed service role key would ship to the
 * browser as a string literal.
 *
 * Secrets are therefore read from `process.env` at request time, and this
 * module lives under `src/server/**` so the build's import protection
 * (behavior: "error") fails the build if it is ever reachable from client code.
 */
import "@tanstack/react-start/server-only";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[server/env] Missing required environment variable ${name}. ` +
        `Set it in .env.local for local dev and in the Vercel project settings for deploys. ` +
        `Do NOT add a VITE_ prefix — that would expose it to the browser.`,
    );
  }
  return value;
}

/** Supabase project URL. Public information — safe to share with the client. */
export function supabaseUrl(): string {
  return process.env.SUPABASE_URL ?? import.meta.env.VITE_SUPABASE_URL;
}

/** Service role key. Bypasses RLS — must never leave the server. */
export function supabaseServiceRoleKey(): string {
  return required("SUPABASE_SERVICE_ROLE_KEY");
}

/** Secret used to seal the admin session cookie (>= 32 chars). */
export function adminSessionSecret(): string {
  return required("ADMIN_SESSION_SECRET");
}
