import type {
  ConversationForThread,
  ConversationThreadPage,
  ExpiredOutboundMessage,
  HandoverConversationSummary,
  HandoverInboxItem,
  HandoverInboxListInput,
  HumanTemplateOutboundReservation,
  MessageChannelType,
  MessageSenderType,
  OutboundDeliveryStatus,
  OutboundFinalizeResult,
  OutboundReservation,
  ServiceWindowState,
} from "./types.js";

/** Minimal projection needed to authorize an AI-message reconciliation request before invoking the trusted RPC. */
export interface OutboundMessageForReconciliation {
  id: string;
  companyId: string;
  senderType: MessageSenderType;
  outboundStatus: OutboundDeliveryStatus | null;
}

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

  /**
   * Meta/WhatsApp Batch 2: the most recent qualifying inbound customer
   * message for this conversation, used to decide whether the 24-hour
   * WhatsApp free-form service window is open. Read under RLS (this
   * repository's authenticated client) -- safe because any role holding
   * conversations.reply (required to reach this at all) is expected to also
   * hold conversations.view, which messages_select_member requires.
   */
  getLastCustomerMessageAt(conversationId: string): Promise<string | null>;

  /**
   * Reserves an explicit, human-initiated send of the conversation's
   * configured service-window re-engagement template (Phase 8) -- never
   * accepts a template id/name from the caller; the underlying RPC resolves
   * and validates the ONE account-configured, currently-approved fallback
   * itself and returns its name/language.
   */
  reserveHumanTemplateOutboundMessage(
    conversationId: string,
    idempotencyKey: string,
  ): Promise<HumanTemplateOutboundReservation>;

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

  /**
   * Reads a conversation's summary fields plus its company_id (RLS-protected
   * authenticated client). Returns null for a conversation that genuinely
   * does not exist, one RLS has hidden (wrong company, revoked membership),
   * or a malformed id -- these three cases are indistinguishable to the
   * caller by design (see getConversationThreadForDashboard).
   */
  getConversationForThread(conversationId: string): Promise<ConversationForThread | null>;
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

  /**
   * Meta/WhatsApp Batch 2: resolves, from the inbound message that triggered
   * this reply, the most recent qualifying inbound customer message for its
   * conversation (for the 24-hour free-form window check) and the WABA's
   * currently-approved service-window fallback template, if any. Reads
   * directly (bypasses RLS, since this is the service-role repository) --
   * correct regardless of any per-role whatsapp.view grant, which the
   * background workers calling this never have a session for anyway.
   */
  getServiceWindowState(sourceMessageId: string): Promise<ServiceWindowState>;

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

  /**
   * Reads a message's company/sender_type/outbound_status directly (bypasses
   * RLS, since this runs on the service_role client) -- used to authorize an
   * AI-message reconciliation request (tenant + sender_type checks) BEFORE
   * calling reconcileOutboundMessage, since the RLS the authenticated path
   * would normally rely on does not apply here. Returns null if no such
   * message exists.
   */
  getMessageForReconciliation(messageId: string): Promise<OutboundMessageForReconciliation | null>;

  /**
   * Calls reconcile_outbound_message as service_role -- the only role
   * migration 12 permits to reconcile an AI-authored message (auth.uid()
   * must be null). Never callable with an authenticated-user client.
   */
  reconcileOutboundMessage(
    messageId: string,
    resolution: "confirm_sent" | "confirm_not_sent",
    providerMessageId?: string | null,
    reason?: string | null,
  ): Promise<OutboundFinalizeResult>;
}
