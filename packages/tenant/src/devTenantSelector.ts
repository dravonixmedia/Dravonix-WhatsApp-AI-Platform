import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Stage A development helper (Master Prompt section 2): lets a developer switch
 * between seeded demo companies while testing against the single Meta test
 * phone number, without needing a distinct WhatsApp number per company.
 *
 * Callers MUST check `env.devTenantSelectorEnabled` (packages/config) before
 * rendering any UI built on this and before honoring its result -- this module
 * itself does not read env vars so it stays testable, but every call site is
 * required to gate on the flag, and packages/config throws at startup if the
 * flag is ever true outside APP_ENV=development.
 */
export interface DevTenantOption {
  companyId: string;
  name: string;
  slug: string;
}

export async function listDevTenantOptions(client: SupabaseClient): Promise<DevTenantOption[]> {
  const { data, error } = await client
    .from("companies")
    .select("id, name, slug")
    .eq("is_demo", true)
    .order("name", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    companyId: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
  }));
}
