"use server";

import { loadEnv } from "@dravonix/config";
import {
  AnthropicChatAgentProvider,
  ChatAgentOverloadedError,
  ChatAgentProviderError,
  ChatAgentRateLimitedError,
  ChatAgentRequestFailedError,
  ChatAgentResponseError,
  ChatAgentValidationError,
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
  | "AI_REQUEST_FAILED";

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

    const context = await loadChatAgentContext(
      supabase,
      session.activeCompanyId,
      input.conversationId,
      threadMessages,
    );

    const provider = new AnthropicChatAgentProvider({
      apiKey: env.ANTHROPIC_API_KEY!,
      model: env.ANTHROPIC_MODEL,
      maxTokens: env.ANTHROPIC_MAX_TOKENS,
    });

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
      if (error instanceof ChatAgentValidationError) {
        // Message is already a short, safe, staff-facing string (e.g. "Write
        // a draft first...") -- returned as-is, never wrapped or replaced.
        return errorResult("INVALID_REQUEST", error.message);
      }
      if (error instanceof ChatAgentRateLimitedError) {
        log.warn("chat_agent_action_rate_limited", { action: input.action });
        return errorResult("AI_RATE_LIMITED", RATE_LIMITED_MESSAGE);
      }
      if (error instanceof ChatAgentOverloadedError) {
        log.warn("chat_agent_action_overloaded", { action: input.action });
        return errorResult("AI_TEMPORARILY_UNAVAILABLE", BUSY_MESSAGE);
      }
      if (error instanceof ChatAgentProviderError) {
        log.warn("chat_agent_action_failed", { action: input.action, errorType: error.name });
        return errorResult("AI_TEMPORARILY_UNAVAILABLE", UNAVAILABLE_MESSAGE);
      }
      if (error instanceof ChatAgentRequestFailedError || error instanceof ChatAgentResponseError) {
        log.warn("chat_agent_action_failed", { action: input.action, errorType: error.name });
        return errorResult("AI_REQUEST_FAILED", REQUEST_FAILED_MESSAGE);
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
