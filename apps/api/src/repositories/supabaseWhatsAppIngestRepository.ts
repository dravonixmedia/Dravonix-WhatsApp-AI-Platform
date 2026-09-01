import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RecordInboundMessageInput,
  RecordStatusEventInput,
  UpsertContactInput,
  WhatsAppIngestRepository,
} from "./whatsappIngestRepository.js";

/**
 * Production implementation of WhatsAppIngestRepository against the Supabase
 * schema in supabase/migrations/*.sql. Uses the service-role client (bypasses
 * RLS) since this runs entirely server-side in the webhook route -- see
 * DATABASE.md's write-path convention.
 */
export class SupabaseWhatsAppIngestRepository implements WhatsAppIngestRepository {
  constructor(private readonly client: SupabaseClient) {}

  async resolveCompanyIdByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    // status = "connected" only -- a disabled/not_connected/error mapping
    // must never route a new inbound message into a tenant (Meta/WhatsApp
    // Batch 1: admin_set_whatsapp_account_status/
    // admin_set_whatsapp_phone_number_status, migration 35). This falls
    // through to the existing safe "unrouted" behavior below, exactly like
    // an unknown phone_number_id -- never a different code path.
    const { data, error } = await this.client
      .from("whatsapp_phone_numbers")
      .select("company_id")
      .eq("phone_number_id", phoneNumberId)
      .eq("status", "connected")
      .maybeSingle();
    if (error) throw error;
    return data?.company_id ?? null;
  }

  async isDuplicateWebhookEvent(providerEventId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("webhook_events")
      .select("id")
      .eq("source", "whatsapp")
      .eq("provider_event_id", providerEventId)
      .maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  async recordWebhookEvent(input: {
    providerEventId: string;
    companyId: string | null;
    status: "received" | "processed" | "duplicate" | "unrouted";
    rawPayload: unknown;
  }): Promise<void> {
    const { error } = await this.client.from("webhook_events").insert({
      source: "whatsapp",
      provider_event_id: input.providerEventId,
      company_id: input.companyId,
      status: input.status,
      raw_payload: input.rawPayload,
      processed_at: new Date().toISOString(),
    });
    // A unique-violation here means a concurrent delivery already recorded this
    // event -- treat as already-handled rather than an error (idempotency).
    if (error && error.code !== "23505") throw error;
  }

  async isDuplicateMessage(providerMessageId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("messages")
      .select("id")
      .eq("provider_message_id", providerMessageId)
      .maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  async upsertContactAndConversation(
    input: UpsertContactInput,
  ): Promise<{ contactId: string; conversationId: string }> {
    const { data: contact, error: contactError } = await this.client
      .from("contacts")
      .upsert(
        {
          company_id: input.companyId,
          whatsapp_wa_id: input.waId,
          profile_name: input.profileName,
        },
        { onConflict: "company_id,whatsapp_wa_id", ignoreDuplicates: false },
      )
      .select("id")
      .single();
    if (contactError) throw contactError;

    const { data: existingConversation, error: findError } = await this.client
      .from("conversations")
      .select("id")
      .eq("company_id", input.companyId)
      .eq("contact_id", contact.id)
      .neq("state", "closed")
      .maybeSingle();
    if (findError) throw findError;

    if (existingConversation) {
      return { contactId: contact.id, conversationId: existingConversation.id };
    }

    // Recorded so the message-consumer worker knows which Meta phone_number_id
    // to reply from without re-deriving it later -- see conversations.whatsapp_phone_number_id.
    const { data: phoneNumberRow, error: phoneNumberError } = await this.client
      .from("whatsapp_phone_numbers")
      .select("id")
      .eq("phone_number_id", input.phoneNumberId)
      .maybeSingle();
    if (phoneNumberError) throw phoneNumberError;

    const { data: newConversation, error: createError } = await this.client
      .from("conversations")
      .insert({
        company_id: input.companyId,
        contact_id: contact.id,
        whatsapp_phone_number_id: phoneNumberRow?.id ?? null,
        state: "ai_active",
      })
      .select("id")
      .single();
    if (createError) throw createError;

    return { contactId: contact.id, conversationId: newConversation.id };
  }

  async recordInboundMessage(input: RecordInboundMessageInput): Promise<{ messageId: string }> {
    const { data, error } = await this.client
      .from("messages")
      .insert({
        company_id: input.companyId,
        conversation_id: input.conversationId,
        direction: "inbound",
        channel_type: input.channelType,
        sender_type: "customer",
        provider_message_id: input.providerMessageId,
        body: input.body,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { messageId: data.id };
  }

  async recordMessageStatusEvent(input: RecordStatusEventInput): Promise<void> {
    const { data: message, error: findError } = await this.client
      .from("messages")
      .select("id, company_id")
      .eq("provider_message_id", input.providerMessageId)
      .maybeSingle();
    if (findError) throw findError;
    if (!message) return; // status for a message we don't have a record of yet; safe to ignore

    const { error } = await this.client.from("message_status_events").insert({
      company_id: message.company_id,
      message_id: message.id,
      status: input.status,
      failure_reason: input.failureReason,
    });
    if (error) throw error;
  }
}
