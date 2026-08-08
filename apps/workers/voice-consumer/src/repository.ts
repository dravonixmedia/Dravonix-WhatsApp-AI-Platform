import type { CompanyAiContext, ConversationMemoryContext, LeadUpdates } from "@dravonix/ai";
import type { AiMode, ConversationState, ConversationTemporalContext } from "@dravonix/core";
import type { ReplyModeSetting } from "@dravonix/speech";

export interface VoiceSettings {
  isEnabled: boolean;
  defaultVoiceByLanguage: Record<string, string>;
  speakingRate: number;
  maxReplyDurationSeconds: number;
  maxIncomingDurationSeconds: number;
  replyMode: ReplyModeSetting;
  retentionDays: number;
  fallbackBehavior: "text_only_with_notice" | "escalate" | "retry_once";
}

export interface VoiceConversationContext {
  companyId: string;
  conversationState: ConversationState;
  /** Human Handover Inbox: AI automation mode, independent of conversationState -- see isAiReplyAllowed. */
  aiMode: AiMode;
  aiContext: CompanyAiContext;
  memory: ConversationMemoryContext;
  /** Resolved from the company's and contact's stored timezones at load time -- same shape/source as message-consumer's, so text and transcribed voice never see different temporal behaviour. */
  temporal: ConversationTemporalContext;
  waId: string;
  phoneNumberId: string;
  voiceSettings: VoiceSettings;
}

/**
 * Handover-triggering and the base outbound `messages` row lifecycle have
 * moved to @dravonix/handover's HandoverWorkerRepository (triggerHandoverAtomic,
 * reserve/finalizeAiOutboundMessage) -- this repository now only covers what
 * remains voice-specific: conversation context, inbound audio/transcription
 * bookkeeping, the media_files/generated_audio rows for an outbound voice
 * reply (linked to a `messages` row that reserve/finalizeAiOutboundMessage
 * already created), lead updates, and voice job failure recording.
 *
 * Retry safety (voice pipeline reliability phase): `payload.messageId` --
 * the inbound `messages.id` row already created by the WhatsApp webhook
 * handler before this job was ever enqueued -- is the stable logical
 * identity for one inbound voice note across every redelivery/retry of the
 * same queue job (see processVoiceJob.ts's top-level comment). The finder
 * and recorder methods below are select-or-create: each checks for
 * already-persisted state for that identity before doing any new work, so a
 * retried job reuses prior progress instead of duplicating it.
 */
export interface VoiceConsumerRepository {
  loadConversationContext(conversationId: string): Promise<VoiceConversationContext>;

  /**
   * Returns the transcript already persisted for this inbound message, if a
   * prior attempt completed the full transcription stage. Checked first,
   * before any WhatsApp media download or STT provider call -- lets the
   * caller skip both entirely on retry (PHASE 4/5 retry safety).
   */
  findExistingTranscription(input: { messageId: string }): Promise<{
    rawText: string;
    detectedLanguage: string | null;
    languageConfidence: number | null;
  } | null>;

  /**
   * Returns the inbound_audio media_files row already created for this
   * message, if a prior attempt got at least that far but didn't complete
   * transcription. Lets the caller skip re-downloading from WhatsApp and
   * fetch the already-stored object instead (PHASE 4 retry safety).
   */
  findExistingInboundAudio(input: {
    companyId: string;
    messageId: string;
  }): Promise<{ mediaFileId: string; mimeType: string | null } | null>;

  /**
   * Select-or-create. Only called once findExistingInboundAudio() has
   * already returned null for this identity -- still race-guarded against a
   * concurrent duplicate insert on a best-effort basis (a true guarantee
   * requires a unique constraint the current schema doesn't have; see the
   * MIGRATION 16 report).
   */
  recordInboundAudio(input: {
    companyId: string;
    messageId: string;
    storageKey: string;
    mimeType: string | null;
    sizeBytes: number;
    providerMediaId: string;
    retentionExpiresAt: Date;
  }): Promise<{ mediaFileId: string }>;

  /**
   * Select-or-create: no-ops the transcriptions insert if a row already
   * exists for this mediaFileId (same best-effort race guard as
   * recordInboundAudio). Always (idempotently) updates the inbound
   * message's body with the transcript, for human visibility in the inbox.
   */
  recordTranscription(input: {
    companyId: string;
    messageId: string;
    mediaFileId: string;
    provider: string;
    rawText: string;
    detectedLanguage: string | null;
    languageConfidence: number | null;
  }): Promise<void>;

  /** Records media_files + generated_audio for a `messages` row already created via finalizeAiOutboundMessage(channelType: "audio"). Concurrency-safe in practice because the caller only reaches this after winning that row's reserve/claim guard (see outboundMessage.ts). */
  recordGeneratedAudioMetadata(input: {
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
  }): Promise<void>;

  applyLeadUpdates(input: {
    companyId: string;
    conversationId: string;
    leadUpdates: LeadUpdates;
  }): Promise<void>;

  /**
   * Records a terminal (non-retryable) voice job failure in job_failures
   * (PHASE 8). Never persists secrets, raw provider bodies, the full
   * WhatsApp payload, or media binary -- callers must pass only sanitized
   * summary fields. Best-effort deduplicated by jobId (stable across
   * retries of the same logical job; see queuePayloads.ts's JobEnvelope).
   */
  recordJobFailure(input: {
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
  }): Promise<void>;
}
