import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompanyAiContext, ConversationMemoryContext, LeadUpdates } from "@dravonix/ai";
import {
  resolveConversationTemporalContext,
  type AiMode,
  type ConversationState,
} from "@dravonix/core";
import type { VoiceConsumerRepository, VoiceConversationContext } from "../repository.js";

const RECENT_MESSAGE_LIMIT = 10;

/**
 * True for a Postgres unique-violation (SQLSTATE 23505). Used by the
 * select-or-create methods below as a race-loss fallback: until MIGRATION
 * 16 adds the unique constraint this pattern is designed for, no code path
 * can actually raise 23505 here, so this branch is presently unreachable --
 * it's forward-safe scaffolding, not a claim of full concurrency protection
 * today (see the MIGRATION 16 report).
 */
function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: string }).code === "23505",
  );
}

/**
 * Production implementation of VoiceConsumerRepository against the Supabase
 * schema in supabase/migrations/*.sql. Uses the service-role client (bypasses
 * RLS) since this runs entirely server-side in the queue consumer. Mirrors
 * SupabaseMessageConsumerRepository's conversation-context loading, extended
 * with voice_settings.
 */
export class SupabaseVoiceConsumerRepository implements VoiceConsumerRepository {
  constructor(private readonly client: SupabaseClient) {}

  async loadConversationContext(conversationId: string): Promise<VoiceConversationContext> {
    const { data: conversation, error: conversationError } = await this.client
      .from("conversations")
      .select(
        "company_id, contact_id, state, ai_mode, unresolved_questions, whatsapp_phone_number_id, contacts (whatsapp_wa_id, last_detected_language, timezone)",
      )
      .eq("id", conversationId)
      .single();
    if (conversationError) throw conversationError;

    const companyId = conversation.company_id as string;
    const contact = conversation.contacts as unknown as {
      whatsapp_wa_id: string;
      last_detected_language: string | null;
      timezone: string | null;
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
      this.client.from("companies").select("name, timezone").eq("id", companyId).single(),
      this.client.from("company_settings").select("*").eq("company_id", companyId).single(),
      this.client
        .from("ai_settings")
        .select("required_disclaimers")
        .eq("company_id", companyId)
        .maybeSingle(),
      this.client.from("voice_settings").select("*").eq("company_id", companyId).single(),
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
    const voiceSettings = voiceSettingsResult.data;
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
      voiceEnabled: voiceSettings.is_enabled,
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

    // Computed here, at request execution time -- never at module scope --
    // so it can't go stale in a long-lived Cloudflare isolate. Same source
    // and shape as SupabaseMessageConsumerRepository's, so a transcribed
    // voice message and a text message get identical temporal behaviour.
    const temporal = resolveConversationTemporalContext({
      companyTimezone: companyResult.data.timezone,
      customerTimezone: contact.timezone,
      now: new Date(),
    });

    return {
      companyId,
      conversationState: conversation.state as ConversationState,
      aiMode: conversation.ai_mode as AiMode,
      aiContext,
      memory,
      temporal,
      waId: contact.whatsapp_wa_id,
      phoneNumberId,
      voiceSettings: {
        isEnabled: voiceSettings.is_enabled,
        defaultVoiceByLanguage: voiceSettings.default_voice_by_language ?? {},
        speakingRate: Number(voiceSettings.speaking_rate),
        maxReplyDurationSeconds: voiceSettings.max_reply_duration_seconds,
        maxIncomingDurationSeconds: voiceSettings.max_incoming_duration_seconds,
        replyMode: voiceSettings.reply_mode,
        retentionDays: voiceSettings.retention_days,
        fallbackBehavior: voiceSettings.fallback_behavior,
      },
    };
  }

  async findExistingTranscription(input: { messageId: string }): Promise<{
    rawText: string;
    detectedLanguage: string | null;
    languageConfidence: number | null;
  } | null> {
    const { data, error } = await this.client
      .from("transcriptions")
      .select("raw_text, detected_language, language_confidence")
      .eq("message_id", input.messageId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      rawText: data.raw_text,
      detectedLanguage: data.detected_language,
      languageConfidence: data.language_confidence,
    };
  }

  async findExistingInboundAudio(input: {
    companyId: string;
    messageId: string;
  }): Promise<{ mediaFileId: string; mimeType: string | null } | null> {
    const { data, error } = await this.client
      .from("media_files")
      .select("id, mime_type")
      .eq("company_id", input.companyId)
      .eq("message_id", input.messageId)
      .eq("kind", "inbound_audio")
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { mediaFileId: data.id, mimeType: data.mime_type };
  }

  async recordInboundAudio(input: {
    companyId: string;
    messageId: string;
    storageKey: string;
    mimeType: string | null;
    sizeBytes: number;
    providerMediaId: string;
    retentionExpiresAt: Date;
  }): Promise<{ mediaFileId: string }> {
    const { data, error } = await this.client
      .from("media_files")
      .insert({
        company_id: input.companyId,
        kind: "inbound_audio",
        message_id: input.messageId,
        storage_key: input.storageKey,
        mime_type: input.mimeType,
        size_bytes: input.sizeBytes,
        provider_media_id: input.providerMediaId,
        retention_expires_at: input.retentionExpiresAt.toISOString(),
      })
      .select("id")
      .single();
    if (error) {
      // Race-loss fallback -- see isUniqueViolation()'s comment. Only takes
      // effect once MIGRATION 16 adds the unique constraint this depends on.
      if (isUniqueViolation(error)) {
        const existing = await this.findExistingInboundAudio({
          companyId: input.companyId,
          messageId: input.messageId,
        });
        if (existing) return { mediaFileId: existing.mediaFileId };
      }
      throw error;
    }
    return { mediaFileId: data.id };
  }

  async recordTranscription(input: {
    companyId: string;
    messageId: string;
    mediaFileId: string;
    provider: string;
    rawText: string;
    detectedLanguage: string | null;
    languageConfidence: number | null;
  }): Promise<void> {
    const { data: existing, error: existingError } = await this.client
      .from("transcriptions")
      .select("id")
      .eq("media_file_id", input.mediaFileId)
      .maybeSingle();
    if (existingError) throw existingError;

    if (!existing) {
      const { error: transcriptionError } = await this.client.from("transcriptions").insert({
        company_id: input.companyId,
        media_file_id: input.mediaFileId,
        message_id: input.messageId,
        provider: input.provider,
        raw_text: input.rawText,
        detected_language: input.detectedLanguage,
        language_confidence: input.languageConfidence,
      });
      // A unique-violation race loss here just means another attempt won
      // the insert for this media file first -- its transcript is already
      // durable, so this attempt falls through to the idempotent message-
      // body update below rather than treating it as a failure.
      if (transcriptionError && !isUniqueViolation(transcriptionError)) {
        throw transcriptionError;
      }
    }

    const { error: messageUpdateError } = await this.client
      .from("messages")
      .update({ body: input.rawText, detected_language: input.detectedLanguage })
      .eq("id", input.messageId);
    if (messageUpdateError) throw messageUpdateError;
  }

  async recordJobFailure(input: {
    companyId: string | null;
    queueName: string;
    jobId: string;
    correlationId: string;
    messageId: string;
    stage: string;
    attempt: number;
    category: string;
    retryable: boolean;
    errorSummary: string;
  }): Promise<void> {
    // Best-effort dedup by jobId (stable across retries of the same
    // logical job -- see JobEnvelope). job_failures has no unique
    // constraint to enforce this at the database level (see the MIGRATION
    // 16 report's secondary note), so this is a same-request guard only,
    // not a concurrency guarantee.
    const { data: existing, error: existingError } = await this.client
      .from("job_failures")
      .select("id")
      .eq("job_id", input.jobId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) return;

    const { error } = await this.client.from("job_failures").insert({
      company_id: input.companyId,
      queue_name: input.queueName,
      job_id: input.jobId,
      correlation_id: input.correlationId,
      attempt: input.attempt,
      status: "dead_letter",
      // Sanitized, human-readable summary only -- never a raw provider
      // body, API key, header, WhatsApp payload, or media binary (PHASE 8).
      error: input.errorSummary,
      payload: {
        messageId: input.messageId,
        stage: input.stage,
        category: input.category,
        retryable: input.retryable,
      },
    });
    if (error && !isUniqueViolation(error)) throw error;
  }

  async recordGeneratedAudioMetadata(input: {
    companyId: string;
    messageId: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number | null;
    voiceId: string | null;
    language: string;
    sourceText: string;
    retentionExpiresAt: Date;
  }): Promise<void> {
    const { data: mediaFile, error: mediaError } = await this.client
      .from("media_files")
      .insert({
        company_id: input.companyId,
        kind: "outbound_audio",
        message_id: input.messageId,
        storage_key: input.storageKey,
        mime_type: input.mimeType,
        size_bytes: input.sizeBytes,
        duration_seconds: input.durationSeconds,
        retention_expires_at: input.retentionExpiresAt.toISOString(),
      })
      .select("id")
      .single();
    if (mediaError) throw mediaError;

    const { error: generatedAudioError } = await this.client.from("generated_audio").insert({
      company_id: input.companyId,
      message_id: input.messageId,
      media_file_id: mediaFile.id,
      provider: "google",
      voice_id: input.voiceId,
      language: input.language,
      source_text: input.sourceText,
    });
    if (generatedAudioError) throw generatedAudioError;
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
