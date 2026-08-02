import type { AiMode, ConversationState } from "@dravonix/core";
import type { CompanyAiContext, ConversationMemoryContext, LeadUpdates } from "@dravonix/ai";

export interface ConversationContext {
  companyId: string;
  conversationState: ConversationState;
  /** Human Handover Inbox: AI automation mode, independent of conversationState -- see isAiReplyAllowed. */
  aiMode: AiMode;
  aiContext: CompanyAiContext;
  memory: ConversationMemoryContext;
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
}
