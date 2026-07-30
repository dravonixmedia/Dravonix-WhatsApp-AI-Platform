import { PermissionDeniedError, TenantIsolationViolationError } from "@dravonix/core";
import type { CompanyRole, PlatformRole } from "@dravonix/database";

export interface CompanyMembership {
  companyId: string;
  role: CompanyRole;
  permissions: ReadonlySet<string>;
}

export interface TenantContext {
  userId: string;
  membership: CompanyMembership | null;
  platformRole: PlatformRole | null;
}

/**
 * Read-only lookup of a user's membership/permissions and platform role. Kept as
 * an interface (rather than a concrete Supabase query) so tenant-context
 * resolution is unit-testable and so apps/workers/* can supply a queue-payload-
 * backed implementation without depending on an HTTP session.
 */
export interface MembershipRepository {
  getActiveMembership(userId: string, companyId: string): Promise<CompanyMembership | null>;
  getPlatformRole(userId: string): Promise<PlatformRole | null>;
}

export async function resolveTenantContext(
  repo: MembershipRepository,
  input: { userId: string; companyId: string },
): Promise<TenantContext> {
  const [membership, platformRole] = await Promise.all([
    repo.getActiveMembership(input.userId, input.companyId),
    repo.getPlatformRole(input.userId),
  ]);
  return { userId: input.userId, membership, platformRole };
}

/** True if the context has access to the given company, either via membership or platform staff status. */
export function hasCompanyAccess(context: TenantContext, companyId: string): boolean {
  if (context.platformRole) return true;
  return context.membership?.companyId === companyId;
}

/**
 * Throws PermissionDeniedError unless the context has the given permission for
 * companyId (platform staff always pass). Every mutating domain-service function
 * must call this before touching tenant data -- it is the server-side
 * authorization layer that RLS alone cannot replace for service-role code paths.
 */
export function requirePermission(
  context: TenantContext,
  companyId: string,
  permission: string,
): void {
  if (context.platformRole) return;
  if (context.membership?.companyId !== companyId) {
    throw new TenantIsolationViolationError(companyId, context.membership?.companyId ?? "none");
  }
  if (!context.membership.permissions.has(permission)) {
    throw new PermissionDeniedError(companyId, permission);
  }
}

/**
 * Throws TenantIsolationViolationError if a resource's company_id does not match
 * the company the context is scoped to. Use at every read/write boundary where a
 * resource ID is looked up before its company is known to be correct (e.g. "load
 * conversation X then check it belongs to the caller's company").
 */
export function assertResourceBelongsToCompany(
  context: TenantContext,
  resourceCompanyId: string,
): void {
  if (!hasCompanyAccess(context, resourceCompanyId)) {
    throw new TenantIsolationViolationError(
      resourceCompanyId,
      context.membership?.companyId ?? "none",
    );
  }
}
