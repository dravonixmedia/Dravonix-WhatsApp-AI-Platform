import {
  generateValidatedResponse,
  recordAiUsage,
  sanitizeResearchQuery,
  type AiProvider,
} from "@dravonix/ai";
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
  /**
   * DRAIVA Research staging pilot: the Worker environment's half of the
   * double gate (packages/config's RESEARCH_STAGING_ENABLED, which cannot
   * ever be true in production -- see packages/config/src/env.ts). Research
   * only actually activates for a given conversation when this is true AND
   * the company's own `companies.is_demo` flag is also true (see below) --
   * omitting this field (every current test/caller that predates this
   * feature) defaults to false, leaving behavior unchanged.
   */
  researchStagingEnabled?: boolean;
  /**
   * DRAIVA Research -- TEMPORARY staging-only live observability hard gate
   * (see recordResearchDiagnostics below). The literal APP_ENV value
   * (packages/config's loadEnv().APP_ENV), NOT researchStagingEnabled or the
   * per-conversation researchEnabled double gate -- deliberately a separate,
   * direct check so this write can never fire in production even if some
   * other gate were ever misconfigured. Omitting this field (every current
   * test/caller that predates this instrumentation) defaults to `undefined`,
   * which never equals "staging", so no write ever happens.
   */
  appEnv?: string;
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

  // Usage metering (P0 usage repair): an inbound WhatsApp message was
  // received, independent of whatever the AI pipeline decides to do about it
  // below (suppressed by ai_mode, denied by entitlement, etc.) -- that fact
  // is recorded unconditionally, before any gate. Idempotency key is keyed
  // on the durable inbound messageId alone, so a redelivered/retried queue
  // message can never be double-counted. Best-effort: a usage-write failure
  // must never block real message processing, so it's caught and logged
  // rather than thrown (mirrors recordResearchDiagnostics's established
  // best-effort pattern below).
  try {
    await deps.repo.recordUsageEvents([
      {
        companyId: payload.companyId,
        conversationId: payload.conversationId,
        metric: "whatsapp_inbound_messages",
        quantity: 1,
        idempotencyKey: `${payload.messageId}:whatsapp_inbound_messages`,
      },
    ]);
  } catch (error) {
    log.error("Failed to record inbound message usage", safeErrorDetails(error));
  }

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

  // DRAIVA Research staging pilot: a double gate, neither half sufficient on
  // its own -- the Worker environment (RESEARCH_STAGING_ENABLED, never true
  // in production) AND this specific company's own companies.is_demo flag.
  // See packages/config/src/env.ts and CompanyAiContext.isDemo.
  const researchEnabled = Boolean(deps.researchStagingEnabled) && context.aiContext.isDemo === true;

  let response: Awaited<ReturnType<typeof generateValidatedResponse>>["response"];
  let usedFallback: boolean;
  let research: Awaited<ReturnType<typeof generateValidatedResponse>>["research"];
  let researchDiagnostics: Awaited<
    ReturnType<typeof generateValidatedResponse>
  >["researchDiagnostics"];
  let usage: Awaited<ReturnType<typeof generateValidatedResponse>>["usage"];
  let callId: string;
  let repaired: boolean;
  try {
    ({ response, usedFallback, research, researchDiagnostics, usage, callId, repaired } =
      await generateValidatedResponse(
        {
          provider: deps.aiProvider,
          onValidationFailure: (details) =>
            log.error("AI structured response failed validation twice", details),
          research: {
            enabled: researchEnabled,
            onDecision: (decision) =>
              log.debug("Research eligibility evaluated", {
                decision: decision.decision,
                bestKnowledgeRelevance: decision.bestKnowledgeRelevance,
              }),
            onExecuted: (diagnostics) =>
              log.info("Research execution diagnostics", {
                researchStarted: diagnostics.researchStarted,
                researchCompleted: diagnostics.researchCompleted,
                researchReason: diagnostics.researchReason,
                sourceCount: diagnostics.sourceCount,
                researchLatencyMs: diagnostics.researchLatencyMs,
                failureCategory: diagnostics.failureCategory,
              }),
          },
        },
        {
          company: context.aiContext,
          memory: context.memory,
          knowledge,
          customerMessage: payload.body,
          temporal: context.temporal,
          researchEnabled,
        },
      ));
  } catch (error) {
    log.error("Claude request failed", safeErrorDetails(error));
    throw error;
  }

  // Usage metering (P0 usage repair, corrected per independent review /
  // ADR-0004): generateValidatedResponse returning at all (rather than
  // throwing, handled above) means at least one real provider.generate()
  // round trip completed and consumed real, billable tokens -- true
  // regardless of whether the structured output was valid or a
  // repair/fallback was needed (see AiUsageRecorder's doc comment).
  // `repaired` distinguishes one real call from two. Idempotency is keyed
  // on `callId`, NOT payload.messageId -- callId is generated fresh inside
  // generateValidatedResponse for every real invocation, so a queue retry
  // that genuinely re-invokes Claude for this same inbound message gets a
  // distinct callId and is correctly recorded as separate, additional
  // provider consumption, never silently dropped as a duplicate of the
  // first attempt (this is the exact defect the independent review found:
  // keying on messageId alone undercounts real Claude cost on retry).
  // Best-effort, matching the inbound-message usage write above -- a
  // metering failure must never block the customer's reply.
  try {
    await recordAiUsage(deps.repo, {
      companyId: payload.companyId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      callId,
      usage,
      requestCount: repaired ? 2 : 1,
      requestSucceeded: true,
    });
  } catch (error) {
    log.error("Failed to record AI usage", safeErrorDetails(error));
  }

  // Post-hoc query-privacy check (Phase 2 design report section 10): the
  // query Claude actually sent to Anthropic's server-executed web_search
  // tool cannot be intercepted before it fires (unlike a client-executed
  // tool), so this is a detective, not preventive, control -- the
  // preventive control is the WEB RESEARCH prompt instructions
  // (buildSystemPrompt.ts). A violation here means the prompt-level
  // instruction was not followed; it is logged for monitoring, never used
  // to retroactively unsend the search.
  if (research?.searchQueries.length) {
    for (const query of research.searchQueries) {
      const sanitized = sanitizeResearchQuery(query, {
        phoneNumber: payload.waId,
        conversationId: payload.conversationId,
        companyId: payload.companyId,
      });
      if (!sanitized.safe) {
        log.error("Research query privacy violation detected", {
          violationTypes: sanitized.violations.map((v) => v.type),
        });
      }
    }
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
    // Usage metering (P0 usage repair): a genuinely new outbound AI reply was
    // just sent (outboundResult.alreadyHandled already returned above for a
    // retry/redelivery, so this only runs once per real send). Mirrors the
    // exact same real-world event SupabaseEntitlementRepository's
    // monthly_messages count already treats as "one message" (an
    // AI-authored outbound send), so this new usage_events-based number
    // means the same thing as the existing, already-trusted entitlement
    // counter. Idempotency key is keyed on the outbound message's own id
    // (stable per (source_message_id, channel_type), see
    // sendAiOutboundMessage), so a retry can never double-count. Best-effort.
    try {
      await deps.repo.recordUsageEvents([
        {
          companyId: payload.companyId,
          conversationId: payload.conversationId,
          metric: "whatsapp_outbound_messages",
          quantity: 1,
          idempotencyKey: `${outboundResult.messageId}:whatsapp_outbound_messages`,
        },
      ]);
    } catch (error) {
      log.error("Failed to record outbound message usage", safeErrorDetails(error));
    }
  } else {
    log.error("Outbound WhatsApp send failed or is unconfirmed", {
      outboundStatus: outboundResult.outboundStatus,
    });
  }

  // DRAIVA Research -- TEMPORARY staging-only live observability (see
  // MessageConsumerDeps.appEnv's doc comment above and
  // recordResearchDiagnostics's doc comment in repository.ts). Hard-gated on
  // the literal APP_ENV value, never on researchEnabled/researchStagingEnabled
  // alone, so this can never write in production. Best-effort: a failure here
  // must never affect the customer-facing outcome the code above already
  // completed (the WhatsApp reply was already sent), so it's caught and
  // logged rather than thrown.
  if (deps.appEnv === "staging" && researchDiagnostics) {
    try {
      await deps.repo.recordResearchDiagnostics(outboundResult.messageId, {
        ...researchDiagnostics,
      });
    } catch (error) {
      log.error("Failed to record staging-only research diagnostics", safeErrorDetails(error));
    }
  }
}
