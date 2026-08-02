import { loadEnv } from "@dravonix/config";

/**
 * Server-only Supabase connection details. Deliberately not NEXT_PUBLIC_-
 * prefixed / never sent to the browser: every dashboard Supabase call in
 * this app runs server-side (Server Components, Server Actions,
 * middleware) using the anon key plus the caller's own session cookie --
 * see Human Handover Inbox final plan section 15/16 ("no access token ever
 * reaches a client component prop").
 */
export function getSupabaseConnectionConfig(): { url: string; anonKey: string } {
  const env = loadEnv(process.env);
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_ANON_KEY must be configured (see SUPABASE_SETUP.md)",
    );
  }
  return { url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY };
}
