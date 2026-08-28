import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandoverRepository } from "../repository.js";
import { deriveUnreadCount, derivePriority, handoverItemNeedsAttention } from "../priority.js";
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
        "id, state, ai_mode, assigned_member_id, handover_reason, state_changed_at, handover_last_read_at, contacts!inner(id)",
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
    }>;

    if (rows.length === 0) return [];

    // Phase 3A.1: get_conversation_phone_displays (migration 25) resolves
    // full-vs-masked per conversation, server-side, in one batched RPC call
    // -- never a raw contacts.whatsapp_wa_id read here. See
    // apps/web/lib/repositories/phoneDisplay.ts for the identical pattern
    // used by every other conversation-keyed read path (this package can't
    // import from apps/web, so the same small RPC call is inlined here).
    const [{ data: inboundMessages, error: messagesError }, phoneDisplayResult] = await Promise.all(
      [
        this.client
          .from("messages")
          .select("conversation_id, created_at")
          .in(
            "conversation_id",
            rows.map((row) => row.id),
          )
          .eq("direction", "inbound"),
        this.client.rpc("get_conversation_phone_displays", {
          p_conversation_ids: rows.map((row) => row.id),
        }),
      ],
    );
    if (messagesError) throw new Error(messagesError.message);
    if (phoneDisplayResult.error) throw new Error(phoneDisplayResult.error.message);

    const phoneDisplayByConversation = new Map<string, string>();
    for (const row of (phoneDisplayResult.data ?? []) as Array<{
      conversation_id: string;
      phone_display: string;
    }>) {
      phoneDisplayByConversation.set(row.conversation_id, row.phone_display);
    }

    const inboundByConversation = new Map<string, string[]>();
    for (const message of inboundMessages ?? []) {
      const list = inboundByConversation.get(message.conversation_id) ?? [];
      list.push(message.created_at);
      inboundByConversation.set(message.conversation_id, list);
    }

    const now = new Date();
    return rows.map((row) => {
      return {
        conversationId: row.id,
        maskedPhoneNumber: phoneDisplayByConversation.get(row.id) ?? maskPhoneNumber(""),
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

  /**
   * See handoverItemNeedsAttention's doc comment for the exact "requires
   * attention" definition and why it replaced the narrower `state in
   * (handover_requested, queued_for_agent)` check. Reuses
   * listHandoverInbox's own "all_active" filter and unreadCount derivation
   * rather than a second, divergent query.
   */
  async countHandoverBadge(companyId: string): Promise<number> {
    const items = await this.listHandoverInbox({
      companyId,
      filter: "all_active",
      sort: "newest_first",
    });
    return items.filter(handoverItemNeedsAttention).length;
  }

  async getConversationThread(
    conversationId: string,
    pagination?: { before?: string; limit?: number },
  ): Promise<ConversationThreadPage> {
    const limit = pagination?.limit ?? DEFAULT_THREAD_PAGE_SIZE;
    // P1 dashboard hygiene batch: embeds media_files (the only mechanism
    // connecting a message to its stored audio, see supabase/migrations/
    // 00000000000004_conversations.sql) so voice playback never needs a
    // second per-message query. A soft-deleted (retention-expired) row is
    // filtered out in the mapping below, not in this query, since
    // PostgREST's embedded-resource syntax can't express an is-null filter
    // on the embedded table without an inner join that would then drop the
    // whole message row for a text message (which has no media_files row at
    // all) -- excluding after the fact is simpler and just as safe.
    let query = this.client
      .from("messages")
      .select(
        "id, direction, channel_type, sender_type, sender_member_id, body, outbound_status, provider_message_id, created_at, media_files (id, mime_type, duration_seconds, deleted_at)",
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
      media_files:
        | {
            id: string;
            mime_type: string | null;
            duration_seconds: number | null;
            deleted_at: string | null;
          }[]
        | {
            id: string;
            mime_type: string | null;
            duration_seconds: number | null;
            deleted_at: string | null;
          }
        | null;
    }>;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      hasMore,
      messages: page
        .map((row) => {
          const embedded = Array.isArray(row.media_files) ? row.media_files[0] : row.media_files;
          const media = embedded && !embedded.deleted_at ? embedded : null;
          return {
            id: row.id,
            direction: row.direction,
            channelType: row.channel_type,
            senderType: row.sender_type,
            senderMemberId: row.sender_member_id,
            body: row.body,
            outboundStatus: row.outbound_status,
            providerMessageId: row.provider_message_id,
            createdAt: row.created_at,
            mediaFileId: media?.id ?? null,
            mediaMimeType: media?.mime_type ?? null,
            mediaDurationSeconds: media?.duration_seconds ?? null,
          };
        })
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
