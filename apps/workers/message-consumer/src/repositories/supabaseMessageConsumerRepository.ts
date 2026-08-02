import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompanyAiContext, ConversationMemoryContext, LeadUpdates } from "@dravonix/ai";
import type { ConversationState } from "@dravonix/core";
import type { ConversationContext, MessageConsumerRepository } from "../repository.js";

const RECENT_MESSAGE_LIMIT = 10;

/**
 * Production implementation of MessageConsumerRepository against the Supabase
 * schema in supabase/migrations/*.sql. Uses the service-role client (bypasses
 * RLS) since this runs entirely server-side in the queue consumer.
 */
export class SupabaseMessageConsumerRepository implements MessageConsumerRepository {
  constructor(private readonly client: SupabaseClient) {}

  async loadConversationContext(conversationId: string): Promise<ConversationContext> {
    const { data: conversation, error: conversationError } = await this.client
      .from("conversations")
      .select(
        "company_id, contact_id, state, unresolved_questions, whatsapp_phone_number_id, contacts (whatsapp_wa_id, last_detected_language)",
      )
      .eq("id", conversationId)
      .single();
    if (conversationError) throw conversationError;

    const companyId = conversation.company_id as string;
    const contact = conversation.contacts as unknown as {
      whatsapp_wa_id: string;
      last_detected_language: string | null;
    };

    const [
      companyResult,
      settingsResult,
      aiSettingsResult,
      voiceSettingsResult,
      phoneNumberResult,
      preferenceResult,
      leadResult,
      messagesResult,
    ] = await Promise.all([
      this.client.from("companies").select("name").eq("id", companyId).single(),
      this.client.from("company_settings").select("*").eq("company_id", companyId).single(),
      this.client
        .from("ai_settings")
        .select("required_disclaimers")
        .eq("company_id", companyId)
        .maybeSingle(),
      this.client
        .from("voice_settings")
        .select("is_enabled")
        .eq("company_id", companyId)
        .maybeSingle(),
      conversation.whatsapp_phone_number_id
        ? this.client
            .from("whatsapp_phone_numbers")
            .select("phone_number_id")
            .eq("id", conversation.whatsapp_phone_number_id)
            .single()
        : this.client
            .from("whatsapp_phone_numbers")
            .select("phone_number_id")
            .eq("company_id", companyId)
            .limit(1)
            .maybeSingle(),
      this.client
        .from("contact_preferences")
        .select("reply_mode")
        .eq("contact_id", conversation.contact_id)
        .maybeSingle(),
      this.client
        .from("leads")
        .select(
          "customer_name, company_name, service_interest, product_interest, budget, preferred_timeline, email, phone_number, location, notes",
        )
        .eq("conversation_id", conversationId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      this.client
        .from("messages")
        .select("sender_type, body")
        .eq("conversation_id", conversationId)
        .in("sender_type", ["customer", "ai", "human_agent"])
        .order("created_at", { ascending: false })
        .limit(RECENT_MESSAGE_LIMIT),
    ]);

    if (companyResult.error) throw companyResult.error;
    if (settingsResult.error) throw settingsResult.error;
    if (aiSettingsResult.error) throw aiSettingsResult.error;
    if (voiceSettingsResult.error) throw voiceSettingsResult.error;
    if (phoneNumberResult.error) throw phoneNumberResult.error;
    if (preferenceResult.error) throw preferenceResult.error;
    if (leadResult.error) throw leadResult.error;
    if (messagesResult.error) throw messagesResult.error;

    const settings = settingsResult.data;
    const lead = leadResult.data;
    const phoneNumberId = phoneNumberResult.data?.phone_number_id as string | undefined;
    if (!phoneNumberId) {
      throw new Error(`No WhatsApp phone number configured for company ${companyId}`);
    }

    const aiContext: CompanyAiContext = {
      companyId,
      companyName: companyResult.data.name,
      botName: settings.bot_name,
      tone: settings.tone,
      enabledLanguages: settings.enabled_languages,
      fallbackLanguage: settings.fallback_language,
      approvedServices: [],
      approvedProducts: [],
      pricingRules: [],
      businessHours: null,
      policies: [],
      faqs: [],
      restrictedTopics: settings.restricted_topics,
      requiredDisclaimers: aiSettingsResult.data?.required_disclaimers ?? [],
      handoverRules: [],
      confidenceThreshold: Number(settings.confidence_threshold),
      staticFallbackMessage: settings.static_fallback_message,
      voiceEnabled: voiceSettingsResult.data?.is_enabled ?? false,
    };

    const memory: ConversationMemoryContext = {
      recentMessages: (messagesResult.data ?? [])
        .slice()
        .reverse()
        .map((m) => ({
          role: m.sender_type as "customer" | "ai" | "human_agent",
          body: m.body ?? "",
        })),
      summary: null,
      leadState: lead ? leadRowToLeadState(lead) : {},
      unresolvedQuestions: conversation.unresolved_questions ?? [],
      customerReplyPreference: preferenceResult.data?.reply_mode ?? null,
      lastDetectedLanguage: contact?.last_detected_language ?? null,
    };

    return {
      companyId,
      conversationState: conversation.state as ConversationState,
      aiContext,
      memory,
      waId: contact.whatsapp_wa_id,
      phoneNumberId,
    };
  }

  async recordOutboundMessage(input: {
    companyId: string;
    conversationId: string;
    body: string;
    providerMessageId: string;
  }): Promise<void> {
    const { error } = await this.client.from("messages").insert({
      company_id: input.companyId,
      conversation_id: input.conversationId,
      direction: "outbound",
      channel_type: "text",
      sender_type: "ai",
      provider_message_id: input.providerMessageId,
      body: input.body,
    });
    if (error) throw error;

    const { error: updateError } = await this.client
      .from("conversations")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", input.conversationId);
    if (updateError) throw updateError;
  }

  async applyLeadUpdates(input: {
    companyId: string;
    conversationId: string;
    leadUpdates: LeadUpdates;
  }): Promise<void> {
    const { data: conversation, error: conversationError } = await this.client
      .from("conversations")
      .select("contact_id")
      .eq("id", input.conversationId)
      .single();
    if (conversationError) throw conversationError;

    const { data: existingLead, error: findError } = await this.client
      .from("leads")
      .select("id")
      .eq("conversation_id", input.conversationId)
      .maybeSingle();
    if (findError) throw findError;

    const patch = leadUpdatesToRow(input.leadUpdates);

    if (existingLead) {
      // Never overwrite an already-known field with null (Master Prompt section 15).
      const merged = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== null),
      );
      if (Object.keys(merged).length === 0) return;
      const { error } = await this.client.from("leads").update(merged).eq("id", existingLead.id);
      if (error) throw error;
      return;
    }

    const { error } = await this.client.from("leads").insert({
      company_id: input.companyId,
      contact_id: conversation.contact_id,
      conversation_id: input.conversationId,
      ...patch,
    });
    if (error) throw error;
  }

  async triggerHandover(input: { conversationId: string; reason: string }): Promise<void> {
    const { error } = await this.client
      .from("conversations")
      .update({ state: "handover_requested", handover_reason: input.reason })
      .eq("id", input.conversationId);
    if (error) throw error;
  }
}

function leadUpdatesToRow(updates: LeadUpdates): Record<string, string | null> {
  return {
    customer_name: updates.name ?? null,
    company_name: updates.companyName ?? null,
    service_interest: updates.service ?? null,
    product_interest: updates.product ?? null,
    budget: updates.budget ?? null,
    preferred_timeline: updates.timeline ?? null,
    email: updates.email ?? null,
    phone_number: updates.phoneNumber ?? null,
    location: updates.location ?? null,
    notes: updates.notes ?? null,
  };
}

function leadRowToLeadState(lead: Record<string, unknown>): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (lead.customer_name) state.name = lead.customer_name;
  if (lead.company_name) state.companyName = lead.company_name;
  if (lead.service_interest) state.service = lead.service_interest;
  if (lead.product_interest) state.product = lead.product_interest;
  if (lead.budget) state.budget = lead.budget;
  if (lead.preferred_timeline) state.timeline = lead.preferred_timeline;
  if (lead.email) state.email = lead.email;
  if (lead.phone_number) state.phoneNumber = lead.phone_number;
  if (lead.location) state.location = lead.location;
  if (lead.notes) state.notes = lead.notes;
  return state;
}
