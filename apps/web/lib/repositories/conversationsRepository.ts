import type { SupabaseClient } from "@supabase/supabase-js";
import { maskPhoneNumber } from "@dravonix/handover";

export type ConversationListAiModeFilter = "all" | "active" | "paused";
export type ConversationListAssignmentFilter = "all" | "mine" | "unassigned";
export type ConversationListHandoverFilter = "all" | "requested";

export interface ConversationListFilters {
  companyId: string;
  callerMemberId: string;
  search?: string;
  aiMode?: ConversationListAiModeFilter;
  assignment?: ConversationListAssignmentFilter;
  handover?: ConversationListHandoverFilter;
  page: number;
  pageSize: number;
}

export interface ConversationListItem {
  conversationId: string;
  maskedPhoneNumber: string;
  displayName: string | null;
  state: string;
  aiMode: "active" | "paused";
  assignedMemberId: string | null;
  handoverReason: string | null;
  lastMessageAt: string | null;
  handoverLastReadAt: string | null;
  /**
   * Best-effort "there's activity since this was last opened" signal for the
   * list view -- true whenever last_message_at is newer than
   * handover_last_read_at (or the conversation has never been read at all).
   * This is not the same as the precise per-message unread count shown on
   * the conversation-detail page (which has the full loaded thread to count
   * against): computing an exact count for every row in a paginated list
   * would require an additional query per conversation, which the "do not
   * load full message history for every inbox row" requirement rules out.
   */
  hasUnreadActivity: boolean;
  latestMessagePreview: string | null;
  latestMessageChannelType: string | null;
  latestMessageDirection: string | null;
}

export interface ConversationListPage {
  items: ConversationListItem[];
  totalCount: number;
}

interface ConversationRow {
  id: string;
  state: string;
  ai_mode: "active" | "paused";
  assigned_member_id: string | null;
  handover_reason: string | null;
  last_message_at: string | null;
  handover_last_read_at: string | null;
  contacts: {
    whatsapp_wa_id: string;
    display_name: string | null;
    profile_name: string | null;
  } | null;
  messages: Array<{
    body: string | null;
    channel_type: string;
    direction: string;
    created_at: string;
  }> | null;
}

/**
 * Tenant-scoped, paginated conversation list for /dashboard/conversations.
 * RLS additionally enforces company_id scoping regardless of this filter.
 * The latest-message preview uses PostgREST's per-relation order+limit
 * (order on the embedded `messages` foreign table, limit 1 on it) so this
 * never fetches more than one message row per conversation -- not the full
 * history for every row in the list.
 */
export async function listConversations(
  client: SupabaseClient,
  filters: ConversationListFilters,
): Promise<ConversationListPage> {
  let contactIdFilter: string[] | null = null;
  if (filters.search && filters.search.trim().length > 0) {
    const term = filters.search.trim();
    const { data: matchingContacts } = await client
      .from("contacts")
      .select("id")
      .eq("company_id", filters.companyId)
      .or(
        `display_name.ilike.%${term}%,profile_name.ilike.%${term}%,whatsapp_wa_id.ilike.%${term}%`,
      );
    contactIdFilter = (matchingContacts ?? []).map((c) => c.id as string);
    if (contactIdFilter.length === 0) {
      return { items: [], totalCount: 0 };
    }
  }

  let query = client
    .from("conversations")
    .select(
      `id, state, ai_mode, assigned_member_id, handover_reason, last_message_at, handover_last_read_at,
       contacts (whatsapp_wa_id, display_name, profile_name),
       messages (body, channel_type, direction, created_at)`,
      { count: "exact" },
    )
    .eq("company_id", filters.companyId)
    .order("created_at", { foreignTable: "messages", ascending: false })
    .limit(1, { foreignTable: "messages" });

  if (contactIdFilter) {
    query = query.in("contact_id", contactIdFilter);
  }
  if (filters.aiMode && filters.aiMode !== "all") {
    query = query.eq("ai_mode", filters.aiMode);
  }
  if (filters.assignment === "mine") {
    query = query.eq("assigned_member_id", filters.callerMemberId);
  } else if (filters.assignment === "unassigned") {
    query = query.is("assigned_member_id", null);
  }
  if (filters.handover === "requested") {
    query = query.in("state", ["handover_requested", "queued_for_agent"]);
  }

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;
  query = query.order("last_message_at", { ascending: false, nullsFirst: false }).range(from, to);

  const { data, count, error } = await query;
  if (error) throw error;

  const items: ConversationListItem[] = ((data ?? []) as unknown as ConversationRow[]).map(
    (row) => {
      const contact = row.contacts;
      const latestMessage = row.messages?.[0] ?? null;
      const hasUnreadActivity = row.last_message_at
        ? !row.handover_last_read_at ||
          new Date(row.last_message_at).getTime() > new Date(row.handover_last_read_at).getTime()
        : false;

      return {
        conversationId: row.id,
        maskedPhoneNumber: contact ? maskPhoneNumber(contact.whatsapp_wa_id) : "Unknown",
        displayName: contact?.display_name ?? contact?.profile_name ?? null,
        state: row.state,
        aiMode: row.ai_mode,
        assignedMemberId: row.assigned_member_id,
        handoverReason: row.handover_reason,
        lastMessageAt: row.last_message_at,
        handoverLastReadAt: row.handover_last_read_at,
        hasUnreadActivity,
        latestMessagePreview: latestMessage?.body ?? null,
        latestMessageChannelType: latestMessage?.channel_type ?? null,
        latestMessageDirection: latestMessage?.direction ?? null,
      };
    },
  );

  return { items, totalCount: count ?? items.length };
}
