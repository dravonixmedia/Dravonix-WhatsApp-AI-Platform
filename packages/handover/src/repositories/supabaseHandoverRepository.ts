import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandoverRepository } from "../repository.js";
import { deriveUnreadCount, derivePriority } from "../priority.js";
import { maskPhoneNumber } from "../maskPhoneNumber.js";
import type {
  ConversationForThread,
  ConversationThreadMessage,
  ConversationThreadPage,
  HandoverConversationSummary,
  HandoverInboxItem,
  HandoverInboxListInput,
  OutboundDeliveryStatus,
  OutboundFinalizeResult,
  OutboundReservation,
} from "../types.js";

interface HandoverActionRow {
  id: string;
  state: HandoverConversationSummary["state"];
  ai_mode: HandoverConversationSummary["aiMode"];
  assigned_member_id: string | null;
  handover_reason: string | null;
}

function toSummary(row: HandoverActionRow): HandoverConversationSummary {
  return {
    id: row.id,
    state: row.state,
    aiMode: row.ai_mode,
    assignedMemberId: row.assigned_member_id,
    handoverReason: row.handover_reason,
  };
}

async function callRpc<T>(
  client: SupabaseClient,
  name: string,
  params: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(name, params).single();
  if (error) throw new Error(error.message);
  return data as T;
}

const DEFAULT_THREAD_PAGE_SIZE = 50;

/**
 * Dashboard-facing implementation of HandoverRepository (final plan section
 * 15). `client` MUST be a Supabase client scoped to the current dashboard
 * user's session (real access token, never a service-role key) -- every RPC
 * call here relies on the server-side auth.uid() that client carries, and
 * every read relies on RLS being enforced for it.
 */
export class SupabaseHandoverRepository implements HandoverRepository {
  constructor(private readonly client: SupabaseClient) {}

  async assignToMe(conversationId: string): Promise<HandoverConversationSummary> {
    return toSummary(
      await callRpc<HandoverActionRow>(this.client, "handover_assign_to_me", {
        p_conversation_id: conversationId,
      }),
    );
  }

  async assignToMember(
    conversationId: string,
    targetMemberId: string,
  ): Promise<HandoverConversationSummary> {
    return toSummary(
      await callRpc<HandoverActionRow>(this.client, "handover_assign_to_member", {
        p_conversation_id: conversationId,
        p_target_member_id: targetMemberId,
      }),
    );
  }

  async start(conversationId: string): Promise<HandoverConversationSummary> {
    return toSummary(
      await callRpc<HandoverActionRow>(this.client, "handover_start", {
        p_conversation_id: conversationId,
      }),
    );
  }

  async markQueued(conversationId: string): Promise<HandoverConversationSummary> {
    return toSummary(
      await callRpc<HandoverActionRow>(this.client, "handover_mark_queued", {
        p_conversation_id: conversationId,
      }),
    );
  }

  async endHumanAssistance(conversationId: string): Promise<HandoverConversationSummary> {
    return toSummary(
      await callRpc<HandoverActionRow>(this.client, "handover_end_human_assistance", {
        p_conversation_id: conversationId,
      }),
    );
  }

  async closeConversation(conversationId: string): Promise<HandoverConversationSummary> {
    return toSummary(
      await callRpc<HandoverActionRow>(this.client, "handover_close_conversation", {
        p_conversation_id: conversationId,
      }),
    );
  }

  async pauseAi(conversationId: string): Promise<HandoverConversationSummary> {
    return toSummary(
      await callRpc<HandoverActionRow>(this.client, "handover_pause_ai", {
        p_conversation_id: conversationId,
      }),
    );
  }

  async resumeAi(conversationId: string): Promise<HandoverConversationSummary> {
    return toSummary(
      await callRpc<HandoverActionRow>(this.client, "handover_resume_ai", {
        p_conversation_id: conversationId,
      }),
    );
  }

  async markRead(conversationId: string): Promise<{ id: string; handoverLastReadAt: string }> {
    const row = await callRpc<{ id: string; handover_last_read_at: string }>(
      this.client,
      "handover_mark_read",
      { p_conversation_id: conversationId },
    );
    return { id: row.id, handoverLastReadAt: row.handover_last_read_at };
  }

  async reserveHumanOutboundMessage(
    conversationId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<OutboundReservation> {
    const row = await callRpc<{
      id: string;
      claimed: boolean;
      outbound_status: OutboundDeliveryStatus;
      provider_message_id: string | null;
    }>(this.client, "reserve_human_outbound_message", {
      p_conversation_id: conversationId,
      p_body: body,
      p_idempotency_key: idempotencyKey,
    });
    return {
      id: row.id,
      claimed: row.claimed,
      outboundStatus: row.outbound_status,
      providerMessageId: row.provider_message_id,
    };
  }

  async finalizeHumanOutboundMessage(
    messageId: string,
    status: OutboundDeliveryStatus,
    providerMessageId: string | null,
    errorCode: string | null = null,
    retryable: boolean | null = null,
  ): Promise<OutboundFinalizeResult> {
    const row = await callRpc<{ id: string; outbound_status: OutboundDeliveryStatus }>(
      this.client,
      "finalize_human_outbound_message",
      {
        p_message_id: messageId,
        p_status: status,
        p_provider_message_id: providerMessageId,
        p_error_code: errorCode,
        p_retryable: retryable,
      },
    );
    return { id: row.id, outboundStatus: row.outbound_status };
  }

  async reconcileOutboundMessage(
    messageId: string,
    resolution: "confirm_sent" | "confirm_not_sent",
    providerMessageId: string | null = null,
    reason: string | null = null,
  ): Promise<OutboundFinalizeResult> {
    const row = await callRpc<{ id: string; outbound_status: OutboundDeliveryStatus }>(
      this.client,
      "reconcile_outbound_message",
      {
        p_message_id: messageId,
        p_resolution: resolution,
        p_provider_message_id: providerMessageId,
        p_reason: reason,
      },
    );
    return { id: row.id, outboundStatus: row.outbound_status };
  }

  async listHandoverInbox(input: HandoverInboxListInput): Promise<HandoverInboxItem[]> {
    let query = this.client
      .from("conversations")
      .select(
        "id, state, ai_mode, assigned_member_id, handover_reason, state_changed_at, handover_last_read_at, contacts!inner(whatsapp_wa_id)",
      )
      .eq("company_id", input.companyId);

    switch (input.filter) {
      case "unassigned":
        query = query
          .in("state", ["handover_requested", "queued_for_agent"])
          .is("assigned_member_id", null);
        break;
      case "assigned_to_me":
        if (!input.callerMemberId)
          throw new Error("callerMemberId is required for the assigned_to_me filter");
        query = query.eq("assigned_member_id", input.callerMemberId);
        break;
      case "all_active":
        query = query.in("state", ["handover_requested", "queued_for_agent", "human_active"]);
        break;
      case "closed":
        query = query.eq("state", "closed");
        break;
    }

    query = query.order("state_changed_at", { ascending: input.sort === "oldest_first" });

    const { data: conversations, error } = await query;
    if (error) throw new Error(error.message);
    const rows = (conversations ?? []) as Array<{
      id: string;
      state: HandoverInboxItem["state"];
      ai_mode: HandoverInboxItem["aiMode"];
      assigned_member_id: string | null;
      handover_reason: string | null;
      state_changed_at: string;
      handover_last_read_at: string | null;
      contacts: { whatsapp_wa_id: string } | { whatsapp_wa_id: string }[];
    }>;

    if (rows.length === 0) return [];

    const { data: inboundMessages, error: messagesError } = await this.client
      .from("messages")
      .select("conversation_id, created_at")
      .in(
        "conversation_id",
        rows.map((row) => row.id),
      )
      .eq("direction", "inbound");
    if (messagesError) throw new Error(messagesError.message);

    const inboundByConversation = new Map<string, string[]>();
    for (const message of inboundMessages ?? []) {
      const list = inboundByConversation.get(message.conversation_id) ?? [];
      list.push(message.created_at);
      inboundByConversation.set(message.conversation_id, list);
    }

    const now = new Date();
    return rows.map((row) => {
      const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
      return {
        conversationId: row.id,
        maskedPhoneNumber: maskPhoneNumber(contact?.whatsapp_wa_id ?? ""),
        state: row.state,
        aiMode: row.ai_mode,
        priority: derivePriority(row.state, row.state_changed_at, now),
        unreadCount: deriveUnreadCount(
          inboundByConversation.get(row.id) ?? [],
          row.handover_last_read_at,
        ),
        assignedMemberId: row.assigned_member_id,
        handoverReason: row.handover_reason,
        waitingSince: row.state_changed_at,
      };
    });
  }

  async countHandoverBadge(companyId: string): Promise<number> {
    const { count, error } = await this.client
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .in("state", ["handover_requested", "queued_for_agent"]);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  async getConversationThread(
    conversationId: string,
    pagination?: { before?: string; limit?: number },
  ): Promise<ConversationThreadPage> {
    const limit = pagination?.limit ?? DEFAULT_THREAD_PAGE_SIZE;
    let query = this.client
      .from("messages")
      .select(
        "id, direction, channel_type, sender_type, sender_member_id, body, outbound_status, provider_message_id, created_at",
      )
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit + 1);

    if (pagination?.before) {
      query = query.lt("created_at", pagination.before);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      direction: ConversationThreadMessage["direction"];
      channel_type: ConversationThreadMessage["channelType"];
      sender_type: ConversationThreadMessage["senderType"];
      sender_member_id: string | null;
      body: string | null;
      outbound_status: OutboundDeliveryStatus | null;
      provider_message_id: string | null;
      created_at: string;
    }>;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      hasMore,
      messages: page
        .map((row) => ({
          id: row.id,
          direction: row.direction,
          channelType: row.channel_type,
          senderType: row.sender_type,
          senderMemberId: row.sender_member_id,
          body: row.body,
          outboundStatus: row.outbound_status,
          providerMessageId: row.provider_message_id,
          createdAt: row.created_at,
        }))
        .reverse(),
    };
  }

  async getConversationForThread(conversationId: string): Promise<ConversationForThread | null> {
    const { data, error } = await this.client
      .from("conversations")
      .select("id, company_id, state, ai_mode, assigned_member_id, handover_reason")
      .eq("id", conversationId)
      .maybeSingle();
    if (error) {
      // 22P02 = invalid_text_representation (e.g. a malformed non-UUID id) --
      // indistinguishable from "not found" as far as the caller should know.
      if (error.code === "22P02") return null;
      throw new Error(error.message);
    }
    if (!data) return null;
    return {
      id: data.id,
      companyId: data.company_id,
      state: data.state,
      aiMode: data.ai_mode,
      assignedMemberId: data.assigned_member_id,
      handoverReason: data.handover_reason,
    };
  }
}
