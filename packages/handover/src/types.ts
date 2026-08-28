import type {
  ConversationAiMode,
  ConversationState,
  OutboundDeliveryStatus,
} from "@dravonix/database";

export type { ConversationAiMode, ConversationState, OutboundDeliveryStatus };

/** Result shape shared by every handover_* dashboard-action RPC (migration 12, section 10). */
export interface HandoverConversationSummary {
  id: string;
  state: ConversationState;
  aiMode: ConversationAiMode;
  assignedMemberId: string | null;
  handoverReason: string | null;
}

/**
 * A conversation's own summary fields plus its company_id, read directly via
 * the RLS-protected authenticated client -- used to authorize a conversation-
 * detail/thread read before trusting a client-supplied conversationId (see
 * getConversationThreadForDashboard in service.ts).
 */
export interface ConversationForThread extends HandoverConversationSummary {
  companyId: string;
}

/** Result shape shared by reserve_ai_outbound_message / reserve_human_outbound_message. */
export interface OutboundReservation {
  id: string;
  claimed: boolean;
  outboundStatus: OutboundDeliveryStatus;
  providerMessageId: string | null;
}

/** Result shape shared by finalize_ai_outbound_message / finalize_human_outbound_message / reconcile_outbound_message. */
export interface OutboundFinalizeResult {
  id: string;
  outboundStatus: OutboundDeliveryStatus;
}

export type HandoverPriority = "high" | "medium" | "low";

export type HandoverInboxFilterKind = "unassigned" | "assigned_to_me" | "all_active" | "closed";
export type HandoverInboxSort = "newest_first" | "oldest_first";

export interface HandoverInboxListInput {
  companyId: string;
  filter: HandoverInboxFilterKind;
  sort: HandoverInboxSort;
  /** Required when filter === "assigned_to_me". */
  callerMemberId?: string;
}

/** One row of the Human Handover Inbox list (final plan section 16). */
export interface HandoverInboxItem {
  conversationId: string;
  maskedPhoneNumber: string;
  state: ConversationState;
  aiMode: ConversationAiMode;
  priority: HandoverPriority;
  unreadCount: number;
  assignedMemberId: string | null;
  handoverReason: string | null;
  waitingSince: string;
}

export type MessageDirection = "inbound" | "outbound";
export type MessageChannelType = "text" | "audio" | "template" | "system";
export type MessageSenderType = "customer" | "ai" | "human_agent" | "system";

/** One row of the full conversation thread (final plan section 16). */
export interface ConversationThreadMessage {
  id: string;
  direction: MessageDirection;
  channelType: MessageChannelType;
  senderType: MessageSenderType;
  senderMemberId: string | null;
  body: string | null;
  outboundStatus: OutboundDeliveryStatus | null;
  providerMessageId: string | null;
  createdAt: string;
  /**
   * Set only when a non-deleted media_files row exists for this message
   * (voice playback, P1 dashboard hygiene batch) -- null for a text message,
   * a voice message whose media was never stored, or one already removed by
   * retention. The dashboard resolves playback through
   * /api/media/audio/{mediaFileId}, which independently re-verifies
   * company ownership server-side -- this id alone grants no access.
   */
  mediaFileId: string | null;
  mediaMimeType: string | null;
  mediaDurationSeconds: number | null;
}

export interface ConversationThreadPage {
  messages: ConversationThreadMessage[];
  hasMore: boolean;
}

/** One row returned by expire_stale_outbound_sends() -- for the reconciler Worker's own logging only; the RPC already writes its own audit_logs/notifications rows. */
export interface ExpiredOutboundMessage {
  id: string;
  conversationId: string;
  companyId: string;
  senderType: MessageSenderType;
}
