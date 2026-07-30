import { generateValidatedResponse, type AiProvider } from "@dravonix/ai";
import { assertCompanyMayUseProvider, type EntitlementRepository } from "@dravonix/billing";
import { EntitlementDeniedError, isAiReplyAllowed } from "@dravonix/core";
import type { KnowledgeRetriever } from "@dravonix/knowledge";
import type { Logger } from "@dravonix/observability";
import type { WhatsAppProvider } from "@dravonix/whatsapp";
import type { MessageConsumerRepository } from "./repository.js";

export interface MessageJobPayload {
  companyId: string;
  conversationId: string;
  messageId: string;
  waId: string;
  body: string;
}

export interface MessageConsumerDeps {
  repo: MessageConsumerRepository;
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

  if (!isAiReplyAllowed(context.conversationState)) {
    log.info("Skipping AI reply: conversation is not in ai_active state", {
      state: context.conversationState,
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

  const { response, usedFallback } = await generateValidatedResponse(
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
  );

  if (usedFallback) {
    log.warn("Used safe static fallback response after repeated AI validation failure");
  }

  if (response.requiresHuman) {
    await deps.repo.triggerHandover({
      conversationId: payload.conversationId,
      reason: response.handoverReason ?? "ai_requested_handover",
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

  const sendResult = await deps.whatsappProvider.sendText({
    phoneNumberId: context.phoneNumberId,
    toWaId: context.waId,
    body: response.answer,
  });

  await deps.repo.recordOutboundMessage({
    companyId: payload.companyId,
    conversationId: payload.conversationId,
    body: response.answer,
    providerMessageId: sendResult.providerMessageId,
  });
}
