import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getSupabaseConnectionConfig } from "./env.js";

/**
 * Server-side, user-scoped Supabase client bound to the current request's
 * session cookies (real @supabase/ssr session, per Human Handover Inbox
 * final plan section 15) -- every RPC call and RLS-backed read made with
 * this client runs as the actual signed-in user, never a service-role
 * bypass. Safe to call from Server Components (read-only cookie access) and
 * Server Actions/Route Handlers (cookie writes supported); the try/catch
 * below is what makes it safe to call from a plain Server Component, where
 * Next.js disallows writing cookies.
 */
export async function createServerSupabaseClient(): Promise<SupabaseClient> {
  const { url, anonKey } = getSupabaseConnectionConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render -- middleware.ts is
          // responsible for actually refreshing/persisting the session
          // cookie on every request; a Server Component only ever reads it.
        }
      },
    },
  });
}
