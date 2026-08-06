"use server";

import { loadEnv } from "@dravonix/config";
import {
  AnthropicChatAgentProvider,
  isChatAgentOverloadedError,
  isChatAgentProviderError,
  isChatAgentRateLimitedError,
  isChatAgentRequestFailedError,
  isChatAgentResponseError,
  isChatAgentValidationError,
  runChatAgentAction as runChatAgent,
  type ChatAgentActionType,
  type ChatAgentResult,
  type ChatAgentRewriteTone,
  type ChatAgentSupportedLanguage,
} from "@dravonix/ai";
import { getConversationThreadForDashboard, SupabaseHandoverRepository } from "@dravonix/handover";
import { createLogger } from "@dravonix/observability";
import { getDashboardCapabilities } from "../permissions.js";
import { loadChatAgentContext } from "../repositories/chatAgentContext.js";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

/**
 * The ONLY inputs the browser may submit for a Chat Agent request. There is
 * deliberately no companyId, role, permission list, conversation history,
 * system prompt, or contact/lead ownership field here -- every one of those
 * is resolved server-side below, from the authenticated session and
 * server-loaded data, never trusted from this object.
 */
export interface ChatAgentActionInput {
  conversationId: string;
  action: ChatAgentActionType;
  draft?: string;
  targetLanguage?: ChatAgentSupportedLanguage;
  tone?: ChatAgentRewriteTone;
  question?: string;
}

/**
 * Every failure category this action can report to the browser. Deliberately
 * a fixed, closed set -- never a raw provider/DB error, a Next.js digest, a
 * stack trace, or a system-prompt fragment.
 */
export type ChatAgentErrorCode =
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "CONVERSATION_NOT_FOUND"
  | "INVALID_REQUEST"
  | "AI_NOT_CONFIGURED"
  | "AI_TEMPORARILY_UNAVAILABLE"
  | "AI_RATE_LIMITED"
  | "AI_REQUEST_FAILED"
  | "AI_RESPONSE_INVALID";

export type ChatAgentActionResponse =
  ({ ok: true } & ChatAgentResult) | { ok: false; code: ChatAgentErrorCode; message: string };

const UNAUTHENTICATED_MESSAGE = "Please sign in again to use the AI assistant.";
const PERMISSION_DENIED_MESSAGE =
  "You do not have permission to use the AI assistant for this conversation.";
const CONVERSATION_NOT_FOUND_MESSAGE = "This conversation is unavailable.";
const NOT_CONFIGURED_MESSAGE =
  "The AI assistant is not available at the moment. Please contact your administrator.";
const RATE_LIMITED_MESSAGE =
  "The AI assistant is receiving too many requests. Please try again shortly.";
const BUSY_MESSAGE = "The AI assistant is temporarily busy. Please try again shortly.";
const UNAVAILABLE_MESSAGE = "The AI assistant is temporarily unavailable. Please try again.";
const REQUEST_FAILED_MESSAGE = "The AI assistant could not complete this request.";
// The following three are all AI_NOT_CONFIGURED -- 401/403/404 are always a
// configuration problem (bad key, no model access, misspelled/unavailable
// model), never something the requesting staff member caused or can retry.
const INVALID_API_KEY_MESSAGE =
  "The AI assistant is not configured correctly. Please contact your administrator.";
const MODEL_ACCESS_DENIED_MESSAGE =
  "The AI assistant is not available for this account. Please contact your administrator.";
const MODEL_UNAVAILABLE_MESSAGE =
  "The AI assistant configuration is unavailable. Please contact your administrator.";
// The model's response didn't come back as usable structured output
// (summarize/extract_lead) -- retryable, since a fresh generation often
// succeeds where the previous one didn't.
const RESPONSE_INVALID_MESSAGE =
  "The AI assistant returned an incomplete response. Please try again.";

function errorResult(code: ChatAgentErrorCode, message: string): ChatAgentActionResponse {
  return { ok: false, code, message };
}

/**
 * Server-side security boundary for the Dashboard Chat Agent (an internal
 * staff copilot -- see packages/ai/src/chatAgent). Every request re-derives
 * authorization from scratch; nothing here is cached across requests or
 * reused from a prior call:
 *
 *  1. Authenticate the user (getDashboardSession -> supabase.auth.getUser()).
 *  2. Resolve the active company from the caller's own live membership.
 *  3-4. getDashboardSession() itself only returns currently-active
 *       memberships (see lib/session.ts) -- there is no separate "is this
 *       membership still active" step because a stale/disabled membership
 *       never appears in session.memberships at all.
 *  5. Verify the caller holds conversations.reply (this assistant sits next
 *     to the human reply composer, which itself requires the same
 *     permission -- there is no path to reach this action from a role that
 *     couldn't already see the composer).
 *  6-7. getConversationThreadForDashboard loads the conversation and
 *       rejects it outright if it doesn't belong to session.activeCompanyId
 *       (packages/handover/src/service.ts) -- the exact same tenant check
 *       every other conversation-detail page in this app already relies on.
 *  8. loadChatAgentContext loads only authorized, company/conversation-
 *     scoped contact/lead/company-settings rows.
 *  9. All of the above happens before runChatAgent ever calls Anthropic.
 *
 * Never calls sendHumanReplyAction, any handover-lifecycle action, or
 * markConversationRead -- this action only ever returns text for a human to
 * review; it cannot send a message, assign/pause/resume/close a
 * conversation, or create/modify a lead.
 *
 * This function never throws. Next.js redacts a thrown Server Action error
 * in production builds to a generic, undebuggable digest message regardless
 * of how safe the thrown message text is -- so every failure path below
 * returns a structured, serializable { ok: false, code, message } result
 * instead, and the whole body is wrapped in an outer safety net that
 * catches anything unexpected (a DB error, a framework failure, etc.) and
 * still returns a safe, generic result rather than letting it escape.
 */
export async function chatAgentAction(
  input: ChatAgentActionInput,
): Promise<ChatAgentActionResponse> {
  const env = loadEnv(process.env);
  const baseLog = createLogger({ environment: env.APP_ENV, conversationId: input.conversationId });

  try {
    const session = await getDashboardSession();
    if (!session) {
      return errorResult("UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE);
    }

    const log = createLogger({
      environment: env.APP_ENV,
      companyId: session.activeCompanyId,
      conversationId: input.conversationId,
    });

    const capabilities = getDashboardCapabilities(session.activeRole);
    if (!capabilities.canReplyToConversations) {
      return errorResult("PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE);
    }

    const supabase = await createServerSupabaseClient();
    const handoverRepo = new SupabaseHandoverRepository(supabase);

    let conversationState: string;
    let aiMode: "active" | "paused";
    let threadMessages;
    try {
      const { conversation, thread } = await getConversationThreadForDashboard(
        handoverRepo,
        session.activeCompanyId,
        input.conversationId,
      );
      conversationState = conversation.state;
      aiMode = conversation.aiMode;
      threadMessages = thread.messages;
    } catch {
      // Never distinguish "doesn't exist" from "belongs to another tenant" --
      // both look identical to the caller, matching every other
      // conversation-detail page in this app.
      return errorResult("CONVERSATION_NOT_FOUND", CONVERSATION_NOT_FOUND_MESSAGE);
    }

    if (!env.anthropicConfigured) {
      log.warn("chat_agent_provider_not_configured", { action: input.action });
      return errorResult("AI_NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE);
    }

    let context;
    try {
      context = await loadChatAgentContext(
        supabase,
        session.activeCompanyId,
        input.conversationId,
        threadMessages,
      );
    } catch {
      // A DB failure loading contact/lead/company-settings rows -- the
      // conversation itself was already found above. Never logs the raw
      // error (may carry DB error text).
      log.warn("chat_agent_context_load_failed", { action: input.action });
      return errorResult("AI_REQUEST_FAILED", REQUEST_FAILED_MESSAGE);
    }

    let provider: AnthropicChatAgentProvider;
    try {
      provider = new AnthropicChatAgentProvider({
        apiKey: env.ANTHROPIC_API_KEY!,
        model: env.ANTHROPIC_MODEL,
        maxTokens: env.ANTHROPIC_MAX_TOKENS,
      });
    } catch {
      log.warn("chat_agent_provider_initialization_failed", {
        action: input.action,
        model: env.ANTHROPIC_MODEL,
      });
      return errorResult("AI_NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE);
    }

    try {
      const result = await runChatAgent(provider, {
        action: input.action,
        messages: context.messages,
        historyTruncated: context.historyTruncated,
        company: context.company,
        conversation: { state: conversationState, aiMode },
        contact: context.contact,
        lead: context.lead,
        staffDraft: input.draft,
        targetLanguage: input.targetLanguage,
        tone: input.tone,
        question: input.question,
      });
      // Sanitized usage metadata only -- never the prompt, the transcript, or
      // the generated content itself (see the module doc comment on why this
      // is a structured log, not a durable audit_logs row: no safe INSERT
      // path exists for apps/web into that table for a new action type
      // without a migration or widening the locked-down service-role
      // surface -- see apps/web/test/serviceRoleGuard.test.ts).
      log.info("chat_agent_action_succeeded", {
        action: input.action,
        actorUserId: session.userId,
        historyTruncated: context.historyTruncated,
      });
      return { ok: true, ...result };
    } catch (error) {
      // Classification below uses the isChatAgentXError guards, not a bare
      // instanceof: each guard checks instanceof first (the common, correct
      // case within one bundle) and falls back to the error's own stable
      // `category` string property, so classification survives even if
      // Cloudflare/OpenNext bundling ever produces two separate module
      // instances of packages/ai (which would make a plain `instanceof`
      // check fail despite the error being the "same" class conceptually).
      if (isChatAgentValidationError(error)) {
        // Message is already a short, safe, staff-facing string (e.g. "Write
        // a draft first...") -- returned as-is, never wrapped or replaced.
        // Never reaches Anthropic -- rejected before the provider call.
        return errorResult("INVALID_REQUEST", error.message);
      }
      // Every branch below reached Anthropic and is logged with the same
      // sanitized, safe-to-read metadata: which action, which model, the
      // caller (for correlating repeated failures to one company/user), and
      // the provider's own HTTP status/categorical error type -- never the
      // raw error message/body, which can echo request content.
      const providerLogFields = (error: {
        status: number | null;
        providerErrorType: string | null;
      }) => ({
        action: input.action,
        actorUserId: session.userId,
        model: env.ANTHROPIC_MODEL,
        reachedProvider: true,
        httpStatus: error.status,
        providerErrorType: error.providerErrorType,
      });
      if (isChatAgentRateLimitedError(error)) {
        log.warn("chat_agent_provider_error", {
          ...providerLogFields(error),
          internalCategory: "AI_RATE_LIMITED",
        });
        return errorResult("AI_RATE_LIMITED", RATE_LIMITED_MESSAGE);
      }
      if (isChatAgentOverloadedError(error)) {
        log.warn("chat_agent_provider_error", {
          ...providerLogFields(error),
          internalCategory: "AI_TEMPORARILY_UNAVAILABLE",
        });
        return errorResult("AI_TEMPORARILY_UNAVAILABLE", BUSY_MESSAGE);
      }
      if (isChatAgentProviderError(error)) {
        log.warn("chat_agent_provider_error", {
          ...providerLogFields(error),
          internalCategory: "AI_TEMPORARILY_UNAVAILABLE",
        });
        return errorResult("AI_TEMPORARILY_UNAVAILABLE", UNAVAILABLE_MESSAGE);
      }
      if (isChatAgentRequestFailedError(error)) {
        // 401/403/404 are always a configuration problem (bad key, no model
        // access, misspelled/unavailable model) -- distinct, specific,
        // admin-actionable messages. 400 and anything else permanent falls
        // back to the generic AI_REQUEST_FAILED message.
        if (error.status === 401) {
          log.warn("chat_agent_provider_error", {
            ...providerLogFields(error),
            internalCategory: "AI_NOT_CONFIGURED",
          });
          return errorResult("AI_NOT_CONFIGURED", INVALID_API_KEY_MESSAGE);
        }
        if (error.status === 403) {
          log.warn("chat_agent_provider_error", {
            ...providerLogFields(error),
            internalCategory: "AI_NOT_CONFIGURED",
          });
          return errorResult("AI_NOT_CONFIGURED", MODEL_ACCESS_DENIED_MESSAGE);
        }
        if (error.status === 404) {
          log.warn("chat_agent_provider_error", {
            ...providerLogFields(error),
            internalCategory: "AI_NOT_CONFIGURED",
          });
          return errorResult("AI_NOT_CONFIGURED", MODEL_UNAVAILABLE_MESSAGE);
        }
        log.warn("chat_agent_provider_error", {
          ...providerLogFields(error),
          internalCategory: "AI_REQUEST_FAILED",
        });
        return errorResult("AI_REQUEST_FAILED", REQUEST_FAILED_MESSAGE);
      }
      if (isChatAgentResponseError(error)) {
        // The provider call itself succeeded (HTTP 200) -- the model's
        // response just didn't turn into usable structured output for this
        // action (summarize/extract_lead). `stage` pinpoints exactly where;
        // the event name matches the stage so failures are directly
        // greppable without reading a field value. Never logs the response
        // text, only its length, and never the parsed field values.
        const stageEventNames: Record<string, string> = {
          empty_response: "chat_agent_empty_response",
          json_extraction: "chat_agent_json_extraction_failed",
          json_parse: "chat_agent_json_parse_failed",
          schema_validation: "chat_agent_schema_validation_failed",
          result_serialization: "chat_agent_result_serialization_failed",
        };
        log.warn(stageEventNames[error.stage] ?? "chat_agent_response_invalid", {
          action: input.action,
          actorUserId: session.userId,
          model: env.ANTHROPIC_MODEL,
          reachedProvider: true,
          parseStage: error.stage,
          responseCharacterCount: error.responseCharacterCount,
          validationIssueCount: error.validationIssueCount,
        });
        return errorResult("AI_RESPONSE_INVALID", RESPONSE_INVALID_MESSAGE);
      }
      log.error("chat_agent_action_unexpected_error", { action: input.action });
      return errorResult("AI_REQUEST_FAILED", REQUEST_FAILED_MESSAGE);
    }
  } catch {
    // Absolute outer safety net: anything unexpected above (session
    // resolution, permission lookup, conversation loading, context loading)
    // must still never throw out of this Server Action -- Next.js redacts a
    // thrown Server Action error to a generic, undebuggable digest message
    // in production. The raw error is deliberately never read/logged here
    // (it may carry a DB error message or other internal detail); only that
    // something failed.
    baseLog.error("chat_agent_action_unhandled_error", { action: input.action });
    return errorResult("AI_REQUEST_FAILED", REQUEST_FAILED_MESSAGE);
  }
}
