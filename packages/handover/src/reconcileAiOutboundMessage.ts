import { PermissionDeniedError } from "@dravonix/core";
import type { AuditLogWriter } from "@dravonix/observability";
import {
  assertResourceBelongsToCompany,
  requirePermission,
  type TenantContext,
} from "@dravonix/tenant";
import { HandoverMessageNotFoundError, HandoverNotAnAiMessageError } from "./errors.js";
import type { HandoverWorkerRepository } from "./repository.js";
import type { OutboundFinalizeResult } from "./types.js";

export interface ReconcileAiOutboundMessageInput {
  messageId: string;
  resolution: "confirm_sent" | "confirm_not_sent";
  reason: string;
  providerMessageId?: string | null;
}

/**
 * The one trusted, server-only path for reconciling a `delivery_unknown`
 * AI-authored message (final plan section 14): migration 12's
 * `reconcile_outbound_message` only permits this for a caller with no
 * `auth.uid()` at all (i.e. service_role) -- an authenticated browser
 * session can never call it directly for an AI message, by design. This
 * function is what a server-only Server Action / admin route calls instead,
 * using a service_role repository plus the caller's already-resolved
 * TenantContext (never the raw request) to re-derive every check RLS would
 * otherwise have provided:
 *
 *  1. the caller holds `conversations.reconcile` for their own active company
 *  2. the target message actually belongs to that same company (a
 *     cross-tenant message id is rejected here, before the trusted RPC ever
 *     sees it -- service_role bypasses RLS entirely, so this check cannot
 *     be skipped)
 *  3. the target message was actually authored by the AI (a human-agent
 *     message must go through the ordinary authenticated
 *     reconcileOutboundMessage path instead)
 *
 * Finally records a SECOND, distinctly-actioned audit_logs row attributing
 * the action to the real acting manager (actor_user_id, reason) -- the
 * RPC's own audit row is deliberately actor-less (actor_type='system') for
 * AI messages, since service_role has no per-employee identity of its own.
 * This function's audit row is what actually makes the dashboard action
 * traceable to a person. Never touches WhatsApp in any way: no
 * WhatsApp-provider dependency exists in this module's signature at all.
 */
export async function reconcileAiOutboundMessage(
  repo: HandoverWorkerRepository,
  auditWriter: AuditLogWriter,
  tenantContext: TenantContext,
  input: ReconcileAiOutboundMessageInput,
): Promise<OutboundFinalizeResult> {
  // Requires an actual company membership to scope the permission check and
  // the audit row to -- platform-staff status alone is not enough here,
  // unlike read-only access elsewhere in this codebase.
  const companyId = tenantContext.membership?.companyId;
  if (!companyId) {
    throw new PermissionDeniedError("unknown", "conversations.reconcile");
  }
  requirePermission(tenantContext, companyId, "conversations.reconcile");

  const message = await repo.getMessageForReconciliation(input.messageId);
  if (!message) {
    throw new HandoverMessageNotFoundError(input.messageId);
  }

  assertResourceBelongsToCompany(tenantContext, message.companyId);

  if (message.senderType !== "ai") {
    throw new HandoverNotAnAiMessageError(input.messageId, message.senderType);
  }

  const result = await repo.reconcileOutboundMessage(
    input.messageId,
    input.resolution,
    input.providerMessageId ?? null,
    input.reason,
  );

  await auditWriter.write({
    companyId: message.companyId,
    actorUserId: tenantContext.userId,
    actorType: "user",
    action: "handover.ai_outbound_reconciled_by_manager",
    targetType: "message",
    targetId: input.messageId,
    metadata: {
      resolution: input.resolution,
      reason: input.reason,
      previous_status: "delivery_unknown",
      final_status: result.outboundStatus,
    },
  });

  return result;
}
