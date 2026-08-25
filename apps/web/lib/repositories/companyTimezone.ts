import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolves a single company's configured display timezone (companies.timezone,
 * migration 2). Used only for formatting timestamps for display -- never for
 * anything else -- so it deliberately selects nothing but the one column.
 * Returns null for a missing/RLS-hidden company; callers pass that straight
 * into formatDateTime, which falls back to UTC.
 */
export async function getCompanyTimezone(
  client: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("companies")
    .select("timezone")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  return (data as { timezone: string | null } | null)?.timezone ?? null;
}
