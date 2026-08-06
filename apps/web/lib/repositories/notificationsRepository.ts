import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveUnreadCount, maskPhoneNumber } from "@dravonix/handover";

export { NOTIFICATION_BADGE_DISPLAY_CAP, formatBadgeCount } from "../notificationBadge.js";

export interface UnreadConversationSummary {
  conversationId: string;
  displayName: string;
  unreadCount: number;
}

export interface NotificationSummary {
  /**
   * Total unread INBOUND customer messages across every open (non-closed)
   * conversation in this company -- a MESSAGE count, not a conversation
   * count. This is the exact number shown on the top-right notification
   * bell badge (Issue 1) and reused, unmodified, for Overview's "Unread
   * customer messages" KPI (Issue 2) -- the two are backed by this same
   * function so they can never silently drift apart.
   *
   * Only rows read from the `messages` table with direction = 'inbound'
   * ever contribute: inbound rows are always customer-originated by
   * construction (message-consumer/voice-consumer only ever insert
   * direction='inbound' for a WhatsApp-originated webhook payload), so AI
   * and human-agent outbound replies structurally cannot be counted here.
   */
  totalUnreadCustomerMessages: number;
  /** Per-conversation breakdown backing the bell's attention panel, sorted by unreadCount descending. */
  unreadConversations: UnreadConversationSummary[];
}

interface CandidateConversationRow {
  id: string;
  handover_last_read_at: string | null;
  last_message_at: string;
  contacts:
    | { whatsapp_wa_id: string; display_name: string | null; profile_name: string | null }
    | { whatsapp_wa_id: string; display_name: string | null; profile_name: string | null }[]
    | null;
}

/**
 * Company-wide unread-customer-message total and per-conversation
 * breakdown. Uses the same two-step fetch-then-derive technique as
 * packages/handover's listHandoverInbox: PostgREST/supabase-js cannot
 * express a column-to-column comparison within the same row (e.g.
 * `last_message_at > handover_last_read_at`) via `.filter()`, so this
 * fetches every open conversation's id/handover_last_read_at/
 * last_message_at, narrows to candidates whose last_message_at is newer
 * than handover_last_read_at (or never read) in JS, then fetches only
 * those candidates' inbound-message timestamps and runs deriveUnreadCount
 * (the same pure function listHandoverInbox uses) per conversation.
 *
 * Scoped to `company_id = companyId` -- never accepts or trusts a
 * client-supplied company id -- and RLS additionally enforces the same
 * scoping server-side regardless of this filter.
 *
 * Closed conversations are excluded: nothing on a closed conversation is
 * actionable, and handover_close_conversation does not stamp
 * handover_last_read_at, so an old closed conversation would otherwise
 * appear permanently "unread" forever.
 */
export async function loadNotificationSummary(
  client: SupabaseClient,
  companyId: string,
): Promise<NotificationSummary> {
  const { data: conversations, error } = await client
    .from("conversations")
    .select(
      "id, handover_last_read_at, last_message_at, contacts (whatsapp_wa_id, display_name, profile_name)",
    )
    .eq("company_id", companyId)
    .neq("state", "closed")
    .not("last_message_at", "is", null);
  if (error) throw new Error(error.message);

  const rows = (conversations ?? []) as unknown as CandidateConversationRow[];

  const candidates = rows.filter(
    (row) =>
      !row.handover_last_read_at ||
      new Date(row.last_message_at).getTime() > new Date(row.handover_last_read_at).getTime(),
  );
  if (candidates.length === 0) {
    return { totalUnreadCustomerMessages: 0, unreadConversations: [] };
  }

  const { data: inboundMessages, error: messagesError } = await client
    .from("messages")
    .select("conversation_id, created_at")
    .in(
      "conversation_id",
      candidates.map((row) => row.id),
    )
    .eq("direction", "inbound");
  if (messagesError) throw new Error(messagesError.message);

  const inboundByConversation = new Map<string, string[]>();
  for (const message of inboundMessages ?? []) {
    const list = inboundByConversation.get(message.conversation_id) ?? [];
    list.push(message.created_at);
    inboundByConversation.set(message.conversation_id, list);
  }

  let totalUnreadCustomerMessages = 0;
  const unreadConversations: UnreadConversationSummary[] = [];
  for (const row of candidates) {
    const unreadCount = deriveUnreadCount(
      inboundByConversation.get(row.id) ?? [],
      row.handover_last_read_at,
    );
    if (unreadCount === 0) continue;
    totalUnreadCustomerMessages += unreadCount;
    const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
    unreadConversations.push({
      conversationId: row.id,
      displayName:
        contact?.display_name ??
        contact?.profile_name ??
        (contact ? maskPhoneNumber(contact.whatsapp_wa_id) : "Customer"),
      unreadCount,
    });
  }
  unreadConversations.sort((a, b) => b.unreadCount - a.unreadCount);

  return { totalUnreadCustomerMessages, unreadConversations };
}
