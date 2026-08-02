import type { CompanyAiContext, ConversationMemoryContext, LeadUpdates } from "@dravonix/ai";
import type { AiMode, ConversationState } from "@dravonix/core";
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
 * already created), and lead updates.
 */
export interface VoiceConsumerRepository {
  loadConversationContext(conversationId: string): Promise<VoiceConversationContext>;

  recordInboundAudio(input: {
    companyId: string;
    messageId: string;
    storageKey: string;
    mimeType: string | null;
    sizeBytes: number;
    providerMediaId: string;
    retentionExpiresAt: Date;
  }): Promise<{ mediaFileId: string }>;

  /** Also updates the inbound message's body with the transcript, for human visibility in the inbox. */
  recordTranscription(input: {
    companyId: string;
    messageId: string;
    mediaFileId: string;
    provider: string;
    rawText: string;
    detectedLanguage: string | null;
    languageConfidence: number | null;
  }): Promise<void>;

  /** Records media_files + generated_audio for a `messages` row already created via finalizeAiOutboundMessage(channelType: "audio"). */
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
}
