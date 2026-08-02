"use server";

import {
  reconcileAiOutboundMessage,
  SupabaseAuditLogWriter,
  SupabaseHandoverWorkerRepository,
} from "@dravonix/handover";
import { resolveTenantContext, SupabaseMembershipRepository } from "@dravonix/tenant";
import { revalidatePath } from "next/cache";
import { getDashboardSession } from "../session.js";
import { createServerOnlyServiceRoleClient } from "../supabase/serviceRole.js";

/**
 * The one trusted, server-only entry point for reconciling a
 * `delivery_unknown` AI-authored message (final plan section 14). Migration
 * 12's `reconcile_outbound_message` only permits this for a caller with no
 * `auth.uid()` at all -- an authenticated dashboard session can never call
 * it directly for an AI message. This Server Action is the narrow,
 * purpose-built substitute: it never runs in the browser (Next.js Server
 * Actions execute exclusively on the server and are never bundled into
 * client JS), and the service_role key it uses is read from a server-only
 * environment variable that is never NEXT_PUBLIC_-prefixed and therefore
 * never inlined into any client bundle.
 *
 * Deliberately NOT a generic "call any service-role RPC" proxy: it only
 * accepts a messageId/resolution/reason, re-derives the caller's own
 * company/permission live (never trusting the client), and delegates every
 * authorization/tenant/sender-type check to
 * @dravonix/handover's reconcileAiOutboundMessage.
 */
export async function reconcileAiOutboundMessageAction(
  messageId: string,
  conversationId: string,
  resolution: "confirm_sent" | "confirm_not_sent",
  reason: string,
): Promise<void> {
  const session = await getDashboardSession();
  if (!session) throw new Error("Not authenticated");
  if (!reason.trim()) throw new Error("A reason is required to reconcile an AI message");

  const serviceRoleClient = createServerOnlyServiceRoleClient();

  // Re-derives the caller's own membership/permissions live via the
  // service-role client (bypasses RLS, but resolveTenantContext only ever
  // looks up the CALLER's own userId/companyId -- never a client-supplied
  // one) -- this is the server-side authorization layer that RLS alone
  // cannot provide for a service-role code path (final plan section 17).
  const tenantContext = await resolveTenantContext(
    new SupabaseMembershipRepository(serviceRoleClient),
    {
      userId: session.userId,
      companyId: session.activeCompanyId,
    },
  );

  await reconcileAiOutboundMessage(
    new SupabaseHandoverWorkerRepository(serviceRoleClient),
    new SupabaseAuditLogWriter(serviceRoleClient),
    tenantContext,
    { messageId, resolution, reason },
  );

  revalidatePath("/dashboard/handover");
  revalidatePath(`/dashboard/handover/${conversationId}`);
}
