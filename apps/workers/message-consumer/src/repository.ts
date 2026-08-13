import type { AiMode, ConversationState, ConversationTemporalContext } from "@dravonix/core";
import type { CompanyAiContext, ConversationMemoryContext, LeadUpdates } from "@dravonix/ai";

export interface ConversationContext {
  companyId: string;
  conversationState: ConversationState;
  /** Human Handover Inbox: AI automation mode, independent of conversationState -- see isAiReplyAllowed. */
  aiMode: AiMode;
  aiContext: CompanyAiContext;
  memory: ConversationMemoryContext;
  /** Resolved from the company's and contact's stored timezones at load time (Global Timezone + Daypart Awareness). */
  temporal: ConversationTemporalContext;
  waId: string;
  phoneNumberId: string;
}

/**
 * Handover-triggering and outbound-message bookkeeping have moved to
 * @dravonix/handover's HandoverWorkerRepository (triggerHandoverAtomic,
 * reserve/finalizeAiOutboundMessage) -- this repository now only covers what
 * remains specific to text-message processing: loading conversation context
 * and applying AI-derived lead updates.
 */
export interface MessageConsumerRepository {
  loadConversationContext(conversationId: string): Promise<ConversationContext>;
  applyLeadUpdates(input: {
    companyId: string;
    conversationId: string;
    leadUpdates: LeadUpdates;
  }): Promise<void>;
  /**
   * DRAIVA Research -- TEMPORARY staging-only live observability. Writes a
   * sanitized, structural-only diagnostics object (never response text,
   * prompts, search queries, or URLs -- see AnthropicResearchCallDiagnostics
   * in @dravonix/ai) into the already-existing, currently-unused
   * messages.ai_structured_response jsonb column for one outbound AI
   * message. The caller (processMessageJob.ts) is solely responsible for
   * only ever invoking this when APP_ENV === "staging" -- this method
   * itself performs no environment check, since it has no access to it.
   */
  recordResearchDiagnostics(messageId: string, diagnostics: Record<string, unknown>): Promise<void>;
}
