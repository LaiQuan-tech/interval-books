import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-only Supabase client for the public site.
 *
 * The URL and anon key come from the environment (VITE_SUPABASE_URL /
 * VITE_SUPABASE_ANON_KEY) — never hard-coded. Vite inlines them into both the
 * client and the SSR bundle, so the same module works in the route loaders
 * (server) and during client-side navigation.
 *
 * The database grants anon SELECT only (see supabase/migrations/0001_init.sql),
 * so there is nothing to authenticate and nothing to persist.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      })
    : null;

export const isSupabaseConfigured = supabase !== null;
