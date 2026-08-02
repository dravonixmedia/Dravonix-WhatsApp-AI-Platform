import { generateValidatedResponse, type AiProvider } from "@dravonix/ai";
import { assertCompanyMayUseProvider, type EntitlementRepository } from "@dravonix/billing";
import { EntitlementDeniedError, isAiReplyAllowed } from "@dravonix/core";
import type { KnowledgeRetriever } from "@dravonix/knowledge";
import { logHandoverTrigger, type Logger } from "@dravonix/observability";
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
  entitlementRepo: EntitlementRepository;
  knowledgeRetriever: KnowledgeRetriever;
  aiProvider: AiProvider;
  whatsappProvider: WhatsAppProvider;
  logger: Logger;
}

/**
 * Runs a post-send bookkeeping write (recording that a message was sent) and
 * swallows any failure instead of letting it propagate. The WhatsApp send
 * this follows has already irreversibly happened -- if this rethrew, the
 * whole queue job would fail and retry, re-running everything from the top
 * (including a fresh Claude call) and sending the customer a real duplicate
 * message for a failure that's specific to our own bookkeeping, not the send.
 */
async function recordOutboundSafely(log: Logger, record: () => Promise<void>): Promise<void> {
  try {
    await record();
  } catch (error) {
    log.error("Failed to record an outbound message that was already sent to the customer", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

  if (!isAiReplyAllowed(context.conversationState)) {
    // A conversation in handover_requested/queued_for_agent/human_active/paused
    // never automatically returns to ai_active on its own (there is currently
    // no agent_assigned/agent_returns_to_ai code path wired up in apps/api) --
    // every future message on this same conversation will keep hitting this
    // branch silently until a human/operator moves it back. Logged at warn
    // (not info) specifically so this doesn't look like routine, expected
    // behavior when tailing logs.
    log.warn("Skipping AI reply: conversation is not in ai_active state", {
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
  log.debug("Retrieved knowledge chunks", { chunkCount: knowledge.length });

  let response: Awaited<ReturnType<typeof generateValidatedResponse>>["response"];
  let usedFallback: boolean;
  let repaired: boolean;
  try {
    ({ response, usedFallback, repaired } = await generateValidatedResponse(
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
        currentMessageChannel: "text",
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
    const reasonCode = response.handoverReason ?? "ai_requested_handover";
    logHandoverTrigger(log, {
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      reasonCode,
      source: usedFallback ? "validation_fallback" : "claude",
      validationAttemptCount: repaired ? 2 : 1,
      previousState: context.conversationState,
    });
    await deps.repo.triggerHandover({
      conversationId: payload.conversationId,
      reason: reasonCode,
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

  let sendResult: Awaited<ReturnType<WhatsAppProvider["sendText"]>>;
  try {
    sendResult = await deps.whatsappProvider.sendText({
      phoneNumberId: context.phoneNumberId,
      toWaId: context.waId,
      body: response.answer,
    });
  } catch (error) {
    log.error("Outbound WhatsApp send failed", safeErrorDetails(error));
    throw error;
  }
  log.info("Outbound WhatsApp message sent", { providerMessageId: sendResult.providerMessageId });

  await recordOutboundSafely(log, () =>
    deps.repo.recordOutboundMessage({
      companyId: payload.companyId,
      conversationId: payload.conversationId,
      body: response.answer,
      providerMessageId: sendResult.providerMessageId,
    }),
  );
}
