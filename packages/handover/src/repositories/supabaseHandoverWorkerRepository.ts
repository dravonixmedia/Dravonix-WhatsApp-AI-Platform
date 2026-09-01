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
  ServiceWindowFallbackTemplate,
  ServiceWindowState,
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

  /**
   * Four small, explicit, sequential queries rather than one PostgREST
   * embedded-resource select: whatsapp_templates has two distinct FK
   * relationships to whatsapp_accounts (whatsapp_templates.whatsapp_account_id
   * and whatsapp_accounts.service_window_fallback_template_id), which
   * PostgREST cannot disambiguate for an embed without an explicit
   * relationship hint -- explicit queries avoid that ambiguity entirely.
   */
  async getServiceWindowState(sourceMessageId: string): Promise<ServiceWindowState> {
    const { data: source, error: sourceError } = await this.client
      .from("messages")
      .select("conversation_id")
      .eq("id", sourceMessageId)
      .single();
    if (sourceError) throw new Error(sourceError.message);
    const conversationId = source.conversation_id as string;

    const [conversationResult, lastInboundResult] = await Promise.all([
      this.client
        .from("conversations")
        .select("whatsapp_phone_number_id")
        .eq("id", conversationId)
        .single(),
      this.client
        .from("messages")
        .select("created_at")
        .eq("conversation_id", conversationId)
        .eq("direction", "inbound")
        .eq("sender_type", "customer")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (conversationResult.error) throw new Error(conversationResult.error.message);
    if (lastInboundResult.error) throw new Error(lastInboundResult.error.message);

    const phoneNumberId = conversationResult.data.whatsapp_phone_number_id as string | null;
    const lastCustomerMessageAt =
      (lastInboundResult.data?.created_at as string | undefined) ?? null;

    let fallbackTemplate: ServiceWindowFallbackTemplate | null = null;
    if (phoneNumberId) {
      const { data: phoneNumber, error: phoneNumberError } = await this.client
        .from("whatsapp_phone_numbers")
        .select("whatsapp_account_id")
        .eq("id", phoneNumberId)
        .maybeSingle();
      if (phoneNumberError) throw new Error(phoneNumberError.message);

      const accountId = phoneNumber?.whatsapp_account_id as string | undefined;
      if (accountId) {
        const { data: account, error: accountError } = await this.client
          .from("whatsapp_accounts")
          .select("service_window_fallback_template_id")
          .eq("id", accountId)
          .maybeSingle();
        if (accountError) throw new Error(accountError.message);

        const templateId = account?.service_window_fallback_template_id as string | undefined;
        if (templateId) {
          const { data: template, error: templateError } = await this.client
            .from("whatsapp_templates")
            .select("id, name, language, status")
            .eq("id", templateId)
            .maybeSingle();
          if (templateError) throw new Error(templateError.message);
          if (template && template.status === "approved") {
            fallbackTemplate = {
              id: template.id,
              name: template.name,
              language: template.language,
            };
          }
        }
      }
    }

    return { lastCustomerMessageAt, fallbackTemplate };
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
