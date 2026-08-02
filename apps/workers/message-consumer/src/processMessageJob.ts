import { generateValidatedResponse, type AiProvider } from "@dravonix/ai";
import { assertCompanyMayUseProvider, type EntitlementRepository } from "@dravonix/billing";
import { EntitlementDeniedError, isAiReplyAllowed } from "@dravonix/core";
import {
  sendAiOutboundMessage,
  triggerHandoverAtomic,
  type HandoverWorkerRepository,
} from "@dravonix/handover";
import type { KnowledgeRetriever } from "@dravonix/knowledge";
import type { Logger } from "@dravonix/observability";
import { WhatsAppProviderError, type WhatsAppProvider } from "@dravonix/whatsapp";
import type { MessageConsumerRepository } from "./repository.js";

/** Never includes a message body, prompt content, or any provider credential. */
function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof WhatsAppProviderError) {
    return { errorType: "WhatsAppProviderError", status: error.status, errorCode: error.errorCode };
  }
  if (error instanceof Error) {
    return { errorType: error.name, message: error.message };
  }
  return { errorType: "unknown" };
}

export interface MessageJobPayload {
  companyId: string;
  conversationId: string;
  messageId: string;
  waId: string;
  body: string;
}

export interface MessageConsumerDeps {
  repo: MessageConsumerRepository;
  handoverRepo: HandoverWorkerRepository;
  entitlementRepo: EntitlementRepository;
  knowledgeRetriever: KnowledgeRetriever;
  aiProvider: AiProvider;
  whatsappProvider: WhatsAppProvider;
  logger: Logger;
}

/**
 * Processes a single inbound text message end to end: re-check entitlement and
 * conversation state -> retrieve tenant-scoped knowledge -> generate a
 * validated AI response -> send the reply -> apply lead updates / handover.
 *
 * Two hard rules enforced here, both required by the Master Prompt's
 * acceptance criteria:
 *  1. If the conversation is not in `ai_active` (a human has taken over,
 *     it's paused, or closed), the AI never generates or sends a reply
 *     (`isAiReplyAllowed`, Master Prompt section 16).
 *  2. Every provider call (Claude, WhatsApp send) is preceded by
 *     `assertCompanyMayUseProvider`; a suspended/unentitled company causes
 *     this function to call neither provider (Master Prompt section 22-23).
 */
export async function processMessageJob(
  deps: MessageConsumerDeps,
  payload: MessageJobPayload,
): Promise<void> {
  const log = deps.logger.child({
    companyId: payload.companyId,
    conversationId: payload.conversationId,
  });
  const context = await deps.repo.loadConversationContext(payload.conversationId);
  log.debug("Loaded conversation context", { state: context.conversationState });

  if (!isAiReplyAllowed(context.conversationState, context.aiMode)) {
    // Collaborative handover model (Human Handover Inbox final plan section 5):
    // a human being assigned/active does NOT by itself stop the AI -- this only
    // skips when the conversation itself is paused/closed, or an employee has
    // explicitly paused the AI (ai_mode='paused'). Logged at warn (not info)
    // specifically so this doesn't look like routine, expected behavior when
    // tailing logs.
    log.warn("Skipping AI reply: suppressed by conversation state or ai_mode", {
      state: context.conversationState,
      aiMode: context.aiMode,
    });
    return;
  }

  try {
    await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "claude_response");
  } catch (error) {
    if (error instanceof EntitlementDeniedError) {
      log.warn("Blocked Claude call: company not entitled", { reason: error.reason });
      return;
    }
    throw error;
  }

  const knowledge = await deps.knowledgeRetriever.retrieve(payload.companyId, payload.body);
  log.debug("Retrieved knowledge chunks", { chunkCount: knowledge.length });

  let response: Awaited<ReturnType<typeof generateValidatedResponse>>["response"];
  let usedFallback: boolean;
  try {
    ({ response, usedFallback } = await generateValidatedResponse(
      {
        provider: deps.aiProvider,
        onValidationFailure: (details) =>
          log.error("AI structured response failed validation twice", details),
      },
      {
        company: context.aiContext,
        memory: context.memory,
        knowledge,
        customerMessage: payload.body,
      },
    ));
  } catch (error) {
    log.error("Claude request failed", safeErrorDetails(error));
    throw error;
  }

  if (usedFallback) {
    log.warn("Used safe static fallback response after repeated AI validation failure");
  }

  if (response.requiresHuman) {
    const reason = response.handoverReason ?? "ai_requested_handover";
    log.warn("Triggering handover (AI keeps replying collaboratively unless explicitly paused)", {
      reason,
    });
    await triggerHandoverAtomic(deps.handoverRepo, {
      conversationId: payload.conversationId,
      reason,
      sourceMessageId: payload.messageId,
      sourceType: "text",
    });
  }

  if (response.leadUpdates) {
    await deps.repo.applyLeadUpdates({
      companyId: payload.companyId,
      conversationId: payload.conversationId,
      leadUpdates: response.leadUpdates,
    });
  }

  try {
    await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "whatsapp_send");
  } catch (error) {
    if (error instanceof EntitlementDeniedError) {
      log.warn("Blocked WhatsApp send: company not entitled", { reason: error.reason });
      return;
    }
    throw error;
  }

  const outboundResult = await sendAiOutboundMessage(deps.handoverRepo, deps.whatsappProvider, {
    sourceMessageId: payload.messageId,
    channelType: "text",
    phoneNumberId: context.phoneNumberId,
    toWaId: context.waId,
    body: response.answer,
  });

  if (outboundResult.alreadyHandled) {
    // This exact inbound message already produced a text reply (a redelivered
    // queue message, or a retry after a prior success) -- the
    // (source_message_id, channel_type) unique constraint plus the guarded
    // claim already prevented a second WhatsApp call; nothing left to do.
    log.info("Skipped AI reply send: already reserved/sent for this message", {
      outboundStatus: outboundResult.outboundStatus,
    });
    return;
  }

  if (outboundResult.outboundStatus === "sent") {
    log.info("Outbound WhatsApp message sent", { messageId: outboundResult.messageId });
  } else {
    log.error("Outbound WhatsApp send failed or is unconfirmed", {
      outboundStatus: outboundResult.outboundStatus,
    });
  }
}
