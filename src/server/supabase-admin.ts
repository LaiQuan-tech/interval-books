/**
 * Supabase client authenticated with the service role key.
 *
 * This bypasses RLS entirely, which is exactly why the whole admin write path
 * lives behind `adminFnMiddleware`: the database will not second-guess us, so
 * authorization has to be enforced in every server function before we get here.
 *
 * Repos under `src/server/repos/**` assume their caller is already authorized.
 */
import "@tanstack/react-start/server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseServiceRoleKey, supabaseUrl } from "./env";

let client: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (client) return client;

  client = createClient(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return client;
}
