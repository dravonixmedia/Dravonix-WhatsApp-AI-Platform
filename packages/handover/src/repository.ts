import type {
  ConversationThreadPage,
  ExpiredOutboundMessage,
  HandoverConversationSummary,
  HandoverInboxItem,
  HandoverInboxListInput,
  MessageChannelType,
  OutboundDeliveryStatus,
  OutboundFinalizeResult,
  OutboundReservation,
} from "./types.js";

/**
 * Dashboard-facing repository -- backed by an `authenticated`-scoped Supabase
 * client (final plan section 15's "user-scoped client"), so every RPC call
 * here runs with the real caller's auth.uid() and every read goes through
 * RLS. Never accepts a userId/memberId parameter for identity: that always
 * comes from the underlying client's session, exactly like the RPCs
 * themselves (final plan section 4).
 */
export interface HandoverRepository {
  assignToMe(conversationId: string): Promise<HandoverConversationSummary>;
  assignToMember(
    conversationId: string,
    targetMemberId: string,
  ): Promise<HandoverConversationSummary>;
  start(conversationId: string): Promise<HandoverConversationSummary>;
  markQueued(conversationId: string): Promise<HandoverConversationSummary>;
  endHumanAssistance(conversationId: string): Promise<HandoverConversationSummary>;
  closeConversation(conversationId: string): Promise<HandoverConversationSummary>;
  pauseAi(conversationId: string): Promise<HandoverConversationSummary>;
  resumeAi(conversationId: string): Promise<HandoverConversationSummary>;
  markRead(conversationId: string): Promise<{ id: string; handoverLastReadAt: string }>;

  reserveHumanOutboundMessage(
    conversationId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<OutboundReservation>;
  finalizeHumanOutboundMessage(
    messageId: string,
    status: OutboundDeliveryStatus,
    providerMessageId: string | null,
    errorCode?: string | null,
    retryable?: boolean | null,
  ): Promise<OutboundFinalizeResult>;

  reconcileOutboundMessage(
    messageId: string,
    resolution: "confirm_sent" | "confirm_not_sent",
    providerMessageId?: string | null,
    reason?: string | null,
  ): Promise<OutboundFinalizeResult>;

  listHandoverInbox(input: HandoverInboxListInput): Promise<HandoverInboxItem[]>;
  countHandoverBadge(companyId: string): Promise<number>;
  getConversationThread(
    conversationId: string,
    pagination?: { before?: string; limit?: number },
  ): Promise<ConversationThreadPage>;
}

/**
 * Trusted-background-worker-facing repository -- backed by a `service_role`
 * Supabase client, per the disjoint trust boundary described in final plan
 * section 4. Used by apps/workers/message-consumer, voice-consumer, and
 * outbound-reconciler. Never callable with an authenticated-user client (the
 * RPCs themselves revoke authenticated/anon execute).
 */
export interface HandoverWorkerRepository {
  triggerHandover(input: {
    conversationId: string;
    reason: string;
    sourceMessageId: string | null;
    sourceType: "text" | "voice" | "system";
    idempotencyKey?: string | null;
  }): Promise<{
    id: string;
    state: HandoverConversationSummary["state"];
    handoverReason: string | null;
    isNewEvent: boolean;
  }>;

  reserveAiOutboundMessage(
    sourceMessageId: string,
    channelType: MessageChannelType,
  ): Promise<OutboundReservation>;

  finalizeAiOutboundMessage(
    messageId: string,
    status: OutboundDeliveryStatus,
    providerMessageId: string | null,
    body: string | null,
    errorCode?: string | null,
    retryable?: boolean | null,
  ): Promise<OutboundFinalizeResult>;

  /** Calls expire_stale_outbound_sends(); returns the messages it flipped to delivery_unknown. */
  expireStaleOutboundSends(): Promise<ExpiredOutboundMessage[]>;
}
