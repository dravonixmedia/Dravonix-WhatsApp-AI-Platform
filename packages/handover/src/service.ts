import { HandoverConversationNotFoundError, mapHandoverRpcError } from "./errors.js";
import type { HandoverRepository } from "./repository.js";
import type {
  ConversationForThread,
  ConversationThreadPage,
  HandoverConversationSummary,
  HandoverInboxItem,
  HandoverInboxListInput,
  OutboundFinalizeResult,
} from "./types.js";

/**
 * Thin, error-mapping wrappers around each handover_* dashboard-action RPC
 * (final plan section 4). All authorization, row-locking, state-transition,
 * and audit/notification logic lives in the SQL functions themselves (final
 * plan section 17) -- this layer's job is only to give apps/api Server
 * Actions a typed-error surface instead of a raw Postgres exception message.
 */

export async function assignToMe(
  repo: HandoverRepository,
  conversationId: string,
): Promise<HandoverConversationSummary> {
  try {
    return await repo.assignToMe(conversationId);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      conversationId,
      rpc: "handover_assign_to_me",
      permission: "conversations.assign",
    });
  }
}

export async function assignToTeamMember(
  repo: HandoverRepository,
  conversationId: string,
  targetMemberId: string,
): Promise<HandoverConversationSummary> {
  try {
    return await repo.assignToMember(conversationId, targetMemberId);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      conversationId,
      targetMemberId,
      rpc: "handover_assign_to_member",
      permission: "conversations.assign",
    });
  }
}

export async function markAsQueued(
  repo: HandoverRepository,
  conversationId: string,
): Promise<HandoverConversationSummary> {
  try {
    return await repo.markQueued(conversationId);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      conversationId,
      rpc: "handover_mark_queued",
      permission: "conversations.assign",
    });
  }
}

export async function startHumanConversation(
  repo: HandoverRepository,
  conversationId: string,
): Promise<HandoverConversationSummary> {
  try {
    return await repo.start(conversationId);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      conversationId,
      rpc: "handover_start",
      permission: "conversations.assign",
    });
  }
}

export async function pauseAi(
  repo: HandoverRepository,
  conversationId: string,
): Promise<HandoverConversationSummary> {
  try {
    return await repo.pauseAi(conversationId);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      conversationId,
      rpc: "handover_pause_ai",
      permission: "conversations.assign",
    });
  }
}

export async function resumeAi(
  repo: HandoverRepository,
  conversationId: string,
): Promise<HandoverConversationSummary> {
  try {
    return await repo.resumeAi(conversationId);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      conversationId,
      rpc: "handover_resume_ai",
      permission: "conversations.assign",
    });
  }
}

export async function endHumanAssistance(
  repo: HandoverRepository,
  conversationId: string,
): Promise<HandoverConversationSummary> {
  try {
    return await repo.endHumanAssistance(conversationId);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      conversationId,
      rpc: "handover_end_human_assistance",
      permission: "conversations.assign",
    });
  }
}

export async function closeConversation(
  repo: HandoverRepository,
  conversationId: string,
): Promise<HandoverConversationSummary> {
  try {
    return await repo.closeConversation(conversationId);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      conversationId,
      rpc: "handover_close_conversation",
      permission: "conversations.assign",
    });
  }
}

export async function markConversationRead(
  repo: HandoverRepository,
  conversationId: string,
): Promise<{ id: string; handoverLastReadAt: string }> {
  try {
    return await repo.markRead(conversationId);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      conversationId,
      rpc: "handover_mark_read",
      permission: "conversations.view",
    });
  }
}

export async function reconcileOutboundMessage(
  repo: HandoverRepository,
  messageId: string,
  resolution: "confirm_sent" | "confirm_not_sent",
  providerMessageId?: string | null,
  reason?: string | null,
): Promise<OutboundFinalizeResult> {
  try {
    return await repo.reconcileOutboundMessage(messageId, resolution, providerMessageId, reason);
  } catch (error) {
    throw mapHandoverRpcError(error, {
      messageId,
      rpc: "reconcile_outbound_message",
      permission: "conversations.reconcile",
    });
  }
}

export async function listHandoverInbox(
  repo: HandoverRepository,
  input: HandoverInboxListInput,
): Promise<HandoverInboxItem[]> {
  return repo.listHandoverInbox(input);
}

export async function countHandoverBadge(
  repo: HandoverRepository,
  companyId: string,
): Promise<number> {
  return repo.countHandoverBadge(companyId);
}

export async function getConversationThread(
  repo: HandoverRepository,
  conversationId: string,
  pagination?: { before?: string; limit?: number },
): Promise<ConversationThreadPage> {
  return repo.getConversationThread(conversationId, pagination);
}

export interface ConversationThreadForDashboard {
  conversation: ConversationForThread;
  thread: ConversationThreadPage;
}

/**
 * The single, tenant-checked entry point for the conversation-detail page:
 * used for both the initial load and every "load older messages" page.
 * RLS alone would already return zero rows for a cross-tenant or revoked-
 * membership conversationId, but this explicit re-check turns that into a
 * defined, testable outcome (with a fake repo, not just an assumption about
 * live RLS) -- and, critically, makes a missing conversation and a cross-
 * tenant conversation throw the exact same error, so neither the dashboard
 * nor its logs ever reveal that a conversation exists in a different tenant.
 */
export async function getConversationThreadForDashboard(
  repo: HandoverRepository,
  callerCompanyId: string,
  conversationId: string,
  pagination?: { before?: string; limit?: number },
): Promise<ConversationThreadForDashboard> {
  const conversation = await repo.getConversationForThread(conversationId);
  if (!conversation || conversation.companyId !== callerCompanyId) {
    throw new HandoverConversationNotFoundError(conversationId);
  }
  const thread = await repo.getConversationThread(conversationId, pagination);
  return { conversation, thread };
}
