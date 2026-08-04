import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser-side Supabase client, used only to open tenant-scoped Realtime
 * subscriptions (apps/web/lib/realtime/*) -- every read/write of actual data
 * still goes through the server-side client (lib/supabase/server.ts) and
 * Server Actions, never this one.
 *
 * Uses NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY (already
 * present in .env.example), which Next.js inlines into the client bundle at
 * build time -- deliberately distinct from the server-only SUPABASE_URL/
 * SUPABASE_ANON_KEY in packages/config/src/env.ts, which are never sent to
 * the browser. Both pairs hold the same publishable anon key value; only the
 * NEXT_PUBLIC_ copies are safe to reference from client code. The
 * service-role key must never gain a NEXT_PUBLIC_ counterpart.
 */
export function createBrowserSupabaseClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set to use Realtime.",
    );
  }
  return createBrowserClient(url, anonKey);
}
