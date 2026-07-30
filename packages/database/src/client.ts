import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseConnectionConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
}

/**
 * Client scoped to an end-user's session (RLS applies). Used by apps/web server
 * components/route handlers on behalf of the signed-in user, and by apps/api for
 * any request made in the context of an authenticated dashboard session.
 */
export function createUserScopedClient(
  config: Pick<SupabaseConnectionConfig, "url" | "anonKey">,
  accessToken: string,
): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Service-role client that bypasses RLS entirely. Used only server-side
 * (apps/api, apps/workers/*) for webhook ingestion, queue consumers, and
 * super-admin operations -- every call site must perform its own explicit
 * authorization (packages/tenant, packages/billing) since RLS provides no
 * protection here. Never expose this client or its key to a browser bundle.
 */
export function createServiceRoleClient(
  config: Required<SupabaseConnectionConfig>,
): SupabaseClient {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Anonymous client, used only for unauthenticated public endpoints (e.g. login). */
export function createAnonClient(
  config: Pick<SupabaseConnectionConfig, "url" | "anonKey">,
): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
