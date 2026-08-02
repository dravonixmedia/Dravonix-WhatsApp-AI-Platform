import { loadEnv } from "@dravonix/config";
import { createServiceRoleClient } from "@dravonix/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConnectionConfig } from "./env.js";

/**
 * Constructs a service_role Supabase client -- bypasses RLS entirely.
 * SUPABASE_SERVICE_ROLE_KEY is a server-only environment variable (never
 * NEXT_PUBLIC_-prefixed, so Next.js never inlines it into a client bundle)
 * and this function must only ever be called from a "use server" module.
 * Every call site MUST perform its own explicit tenant/permission
 * authorization before using this client for anything -- RLS provides no
 * protection here at all. Reserved for the one narrow, audited use in this
 * app: apps/web/lib/actions/reconcileAiOutboundMessage.ts.
 */
export function createServerOnlyServiceRoleClient(): SupabaseClient {
  const { url, anonKey } = getSupabaseConnectionConfig();
  const env = loadEnv(process.env);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY must be configured for this server-only action (see SUPABASE_SETUP.md)",
    );
  }
  return createServiceRoleClient({ url, anonKey, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
}
