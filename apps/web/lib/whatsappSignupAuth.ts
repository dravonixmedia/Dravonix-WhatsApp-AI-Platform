import "server-only";
import {
  requirePermission,
  resolveTenantContext,
  SupabaseMembershipRepository,
  type TenantContext,
} from "@dravonix/tenant";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDashboardSession, type DashboardSession } from "./session.js";
import { createServerOnlyServiceRoleClient } from "./supabase/serviceRole.js";

export interface WhatsappManageAuthContext {
  session: DashboardSession;
  serviceRoleClient: SupabaseClient;
  tenantContext: TenantContext;
}

/** Thrown when there is no signed-in user at all -- callers map this to HTTP 401. */
export class WhatsappSignupUnauthenticatedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "WhatsappSignupUnauthenticatedError";
  }
}

/**
 * Shared authorization gate for every Meta Embedded Signup route (connect,
 * disconnect, reconnect): resolves the caller's real, live dashboard session
 * and re-derives -- via the service-role client, never trusting a
 * client-supplied company_id -- their current whatsapp.manage permission,
 * exactly like reconcileAiOutboundMessageAction's own established pattern
 * (apps/web/lib/actions/reconcileAiOutboundMessage.ts). requirePermission
 * throws PermissionDeniedError/TenantIsolationViolationError (both
 * @dravonix/core AppError subclasses, identified by callers via
 * isDomainError -- see apps/web/lib/domainError.ts) if the caller's live
 * membership does not actually grant whatsapp.manage for their own active
 * company.
 */
export async function requireWhatsappManageContext(): Promise<WhatsappManageAuthContext> {
  const session = await getDashboardSession();
  if (!session) throw new WhatsappSignupUnauthenticatedError();

  const serviceRoleClient = createServerOnlyServiceRoleClient();
  const tenantContext = await resolveTenantContext(
    new SupabaseMembershipRepository(serviceRoleClient),
    { userId: session.userId, companyId: session.activeCompanyId },
  );
  requirePermission(tenantContext, session.activeCompanyId, "whatsapp.manage");

  return { session, serviceRoleClient, tenantContext };
}
