import "server-only";
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
 *
 * The `import "server-only"` above is not just documentation: Next.js's
 * bundler resolves it to a no-op only inside the server/RSC module graph
 * (the "react-server" export condition) -- if this file were ever pulled
 * into a Client Component's bundle, or evaluated outside that graph (e.g.
 * this repo's own Vitest suite, which has no react-server condition
 * configured), the import throws immediately. See
 * apps/web/test/serviceRoleGuard.test.ts.
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
