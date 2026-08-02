import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandoverWorkerRepository, OutboundMessageForReconciliation } from "../repository.js";
import type {
  ExpiredOutboundMessage,
  HandoverConversationSummary,
  MessageChannelType,
  MessageSenderType,
  OutboundDeliveryStatus,
  OutboundFinalizeResult,
  OutboundReservation,
} from "../types.js";

async function callRpc<T>(
  client: SupabaseClient,
  name: string,
  params: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(name, params).single();
  if (error) throw new Error(error.message);
  return data as T;
}

/**
 * Trusted-background-worker implementation of HandoverWorkerRepository
 * (final plan section 4). `client` MUST be a service_role Supabase client --
 * these RPCs revoke execute from authenticated/anon entirely, so an
 * authenticated-user client would get a bare "permission denied" from
 * Postgres, not a domain error.
 */
export class SupabaseHandoverWorkerRepository implements HandoverWorkerRepository {
  constructor(private readonly client: SupabaseClient) {}

  async triggerHandover(input: {
    conversationId: string;
    reason: string;
    sourceMessageId: string | null;
    sourceType: "text" | "voice" | "system";
    idempotencyKey?: string | null;
  }) {
    const row = await callRpc<{
      id: string;
      state: HandoverConversationSummary["state"];
      handover_reason: string | null;
      is_new_event: boolean;
    }>(this.client, "trigger_handover", {
      p_conversation_id: input.conversationId,
      p_reason: input.reason,
      p_source_message_id: input.sourceMessageId,
      p_source_type: input.sourceType,
      p_idempotency_key: input.idempotencyKey ?? null,
    });
    return {
      id: row.id,
      state: row.state,
      handoverReason: row.handover_reason,
      isNewEvent: row.is_new_event,
    };
  }

  async reserveAiOutboundMessage(
    sourceMessageId: string,
    channelType: MessageChannelType,
  ): Promise<OutboundReservation> {
    const row = await callRpc<{
      id: string;
      claimed: boolean;
      outbound_status: OutboundDeliveryStatus;
      provider_message_id: string | null;
    }>(this.client, "reserve_ai_outbound_message", {
      p_source_message_id: sourceMessageId,
      p_channel_type: channelType,
    });
    return {
      id: row.id,
      claimed: row.claimed,
      outboundStatus: row.outbound_status,
      providerMessageId: row.provider_message_id,
    };
  }

  async finalizeAiOutboundMessage(
    messageId: string,
    status: OutboundDeliveryStatus,
    providerMessageId: string | null,
    body: string | null,
    errorCode: string | null = null,
    retryable: boolean | null = null,
  ): Promise<OutboundFinalizeResult> {
    const row = await callRpc<{ id: string; outbound_status: OutboundDeliveryStatus }>(
      this.client,
      "finalize_ai_outbound_message",
      {
        p_message_id: messageId,
        p_status: status,
        p_provider_message_id: providerMessageId,
        p_body: body,
        p_error_code: errorCode,
        p_retryable: retryable,
      },
    );
    return { id: row.id, outboundStatus: row.outbound_status };
  }

  async expireStaleOutboundSends(): Promise<ExpiredOutboundMessage[]> {
    const { data, error } = await this.client.rpc("expire_stale_outbound_sends", {});
    if (error) throw new Error(error.message);
    return (
      (data ?? []) as Array<{
        id: string;
        conversation_id: string;
        company_id: string;
        sender_type: string;
      }>
    ).map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      companyId: row.company_id,
      senderType: row.sender_type as ExpiredOutboundMessage["senderType"],
    }));
  }

  async getMessageForReconciliation(
    messageId: string,
  ): Promise<OutboundMessageForReconciliation | null> {
    const { data, error } = await this.client
      .from("messages")
      .select("id, company_id, sender_type, outbound_status")
      .eq("id", messageId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      id: data.id,
      companyId: data.company_id,
      senderType: data.sender_type as MessageSenderType,
      outboundStatus: data.outbound_status as OutboundDeliveryStatus | null,
    };
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
}
