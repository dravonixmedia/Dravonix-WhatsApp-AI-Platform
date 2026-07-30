import {
  requirePermission,
  resolveTenantContext,
  type MembershipRepository,
  type TenantContext,
} from "@dravonix/tenant";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSession } from "./session.js";

/**
 * Combined authentication + authorization guard for a single request: verifies
 * the bearer token, resolves the caller's membership/permissions for the target
 * company, and asserts the required permission -- throwing UnauthorizedError,
 * PermissionDeniedError, or TenantIsolationViolationError as appropriate.
 *
 * Intended to run at the top of every apps/api route handler that touches
 * tenant-owned data. Returns the resolved TenantContext for the handler to use.
 */
export async function requireCompanyPermission(
  deps: { anonClient: SupabaseClient; membershipRepo: MembershipRepository },
  authorizationHeader: string | null | undefined,
  companyId: string,
  permission: string,
): Promise<TenantContext> {
  const session = await requireSession(deps.anonClient, authorizationHeader);
  const context = await resolveTenantContext(deps.membershipRepo, {
    userId: session.userId,
    companyId,
  });
  requirePermission(context, companyId, permission);
  return context;
}
