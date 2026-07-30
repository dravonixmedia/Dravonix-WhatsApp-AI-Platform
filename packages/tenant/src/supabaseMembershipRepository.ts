import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlatformRole } from "@dravonix/database";
import type { CompanyMembership, MembershipRepository } from "./context.js";

/**
 * Service-role-backed implementation of MembershipRepository. Intended for use in
 * apps/api/apps/workers/* where a service-role Supabase client is already
 * available and re-deriving membership/permissions per request is cheap and
 * always fresh (never trusts a cached JWT claim -- see DATABASE.md).
 */
export class SupabaseMembershipRepository implements MembershipRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getActiveMembership(userId: string, companyId: string): Promise<CompanyMembership | null> {
    const { data: member, error } = await this.client
      .from("company_members")
      .select("role")
      .eq("user_id", userId)
      .eq("company_id", companyId)
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw error;
    if (!member) return null;

    const { data: rolePermissions, error: permError } = await this.client
      .from("role_permissions")
      .select("permission_key")
      .eq("role", member.role);

    if (permError) throw permError;

    return {
      companyId,
      role: member.role,
      permissions: new Set((rolePermissions ?? []).map((row) => row.permission_key as string)),
    };
  }

  async getPlatformRole(userId: string): Promise<PlatformRole | null> {
    const { data, error } = await this.client
      .from("platform_members")
      .select("role")
      .eq("user_id", userId)
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw error;
    return data?.role ?? null;
  }
}
