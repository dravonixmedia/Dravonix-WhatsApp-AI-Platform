import type { ConversationState } from "@dravonix/core";
import type { CompanyAiContext, ConversationMemoryContext, LeadUpdates } from "@dravonix/ai";

export interface ConversationContext {
  companyId: string;
  conversationState: ConversationState;
  aiContext: CompanyAiContext;
  memory: ConversationMemoryContext;
  waId: string;
  phoneNumberId: string;
}

export interface MessageConsumerRepository {
  loadConversationContext(conversationId: string): Promise<ConversationContext>;
  recordOutboundMessage(input: {
    companyId: string;
    conversationId: string;
    body: string;
    providerMessageId: string;
  }): Promise<void>;
  applyLeadUpdates(input: {
    companyId: string;
    conversationId: string;
    leadUpdates: LeadUpdates;
  }): Promise<void>;
  triggerHandover(input: { conversationId: string; reason: string }): Promise<void>;
}
