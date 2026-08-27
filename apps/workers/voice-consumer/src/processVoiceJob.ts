import {
  generateValidatedResponse,
  recordAiUsage,
  type AiProvider,
  type ValidationDiagnosticEvent,
} from "@dravonix/ai";
import { assertCompanyMayUseProvider, type EntitlementRepository } from "@dravonix/billing";
import { EntitlementDeniedError, isAiReplyAllowed } from "@dravonix/core";
import {
  classifySendError,
  sendAiOutboundMessage,
  triggerHandoverAtomic,
  type HandoverWorkerRepository,
} from "@dravonix/handover";
import type { KnowledgeRetriever } from "@dravonix/knowledge";
import type { Logger } from "@dravonix/observability";
import {
  ElevenLabsProviderError,
  isDominantlyMalayalam,
  normalizeTranscript,
  prepareMalayalamSpeechText,
  resolveReplyMode,
  sanitizeKeyterms,
  type SpeechToTextProvider,
  type SpeechToTextResult,
  type TextToSpeechProvider,
} from "@dravonix/speech";
import { buildStorageKey, computeRetentionExpiry, type StorageProvider } from "@dravonix/storage";
import type { WhatsAppProvider } from "@dravonix/whatsapp";
import type { VoiceConsumerRepository } from "./repository.js";

/**
 * Domain-specific vocabulary that biases ElevenLabs Scribe's transcription
 * accuracy for auto-detected/Malayalam-English mixed audio (final plan
 * section 5) -- names and technical terms a generic language model has no
 * reason to expect are the most common source of STT accuracy loss for
 * mixed business speech.
 */
const MALAYALAM_STT_KEYTERMS = [
  "Dravonix",
  "branding",
  "website",
  "quotation",
  "logo",
  "social media",
  "Zoho",
  "CRM",
  "SaaS",
  "Cloudflare",
  "Supabase",
  "Kerala",
];

export interface VoiceJobPayload {
  companyId: string;
  conversationId: string;
  messageId: string;
  waId: string;
  mediaId: string;
  mimeType: string | null;
  /**
   * Queue envelope fields (apps/api/src/queuePayloads.ts's JobEnvelope) --
   * always present on the wire, previously unused by this Worker. Recorded
   * on job_failures rows (PHASE 8): jobId is stable across every
   * redelivery/retry of the same logical job, so it doubles as a
   * best-effort dedup key there.
   */
  jobId: string;
  correlationId: string;
  attempt: number;
}

/**
 * Deployment-wide voice-reply switch, independent of any per-company/contact
 * reply-mode preference resolved by resolveReplyMode(). "text_only" forces
 * every voice job to reply with text alone -- no TTS call, no audio
 * reservation/generation/send/storage -- regardless of language or company
 * config. "text_and_audio" preserves the existing resolveReplyMode()-driven
 * text/voice/text_and_voice behaviour unchanged.
 */
export type VoiceReplyMode = "text_only" | "text_and_audio";

export interface VoiceConsumerDeps {
  repo: VoiceConsumerRepository;
  handoverRepo: HandoverWorkerRepository;
  entitlementRepo: EntitlementRepository;
  knowledgeRetriever: KnowledgeRetriever;
  aiProvider: AiProvider;
  whatsappProvider: WhatsAppProvider;
  sttProvider: SpeechToTextProvider;
  ttsProvider: TextToSpeechProvider;
  storageProvider: StorageProvider;
  logger: Logger;
  voiceReplyMode: VoiceReplyMode;
  /** Logical queue name recorded on job_failures rows (PHASE 8) -- the real Cloudflare queue this batch was delivered from, e.g. "dravonix-voice-queue-staging". */
  queueName: string;
}

/** Maps our simple enabled-language codes to BCP-47 codes Google STT/TTS expect. */
const STT_LANGUAGE_CODES: Record<string, string> = {
  en: "en-US",
  ml: "ml-IN",
  hi: "hi-IN",
  ar: "ar-XA",
};

function toSttLanguageCode(code: string): string {
  return STT_LANGUAGE_CODES[code] ?? "en-US";
}

/**
 * Sends a text notice tied to the inbound voice message via the same
 * reserve -> send -> finalize lifecycle as any other AI text reply (final
 * plan section 12), so a redelivered voice-processing job can't double-send
 * one of these notices either.
 */
async function sendTextNotice(
  deps: VoiceConsumerDeps,
  payload: VoiceJobPayload,
  context: { phoneNumberId: string; waId: string },
  log: Logger,
  notice: string,
): Promise<void> {
  try {
    await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "whatsapp_send");
  } catch (error) {
    if (error instanceof EntitlementDeniedError) return;
    throw error;
  }

  const result = await sendAiOutboundMessage(deps.handoverRepo, deps.whatsappProvider, {
    sourceMessageId: payload.messageId,
    channelType: "text",
    phoneNumberId: context.phoneNumberId,
    toWaId: context.waId,
    body: notice,
  });
  if (result.alreadyHandled) {
    log.info("Skipped notice send: already reserved/sent for this message", {
      outboundStatus: result.outboundStatus,
    });
  }
}

/**
 * Processes a single inbound voice note end to end: download the audio from
 * WhatsApp -> store it -> transcribe -> (same AI pipeline as text messages) ->
 * resolve reply mode -> reply with text and/or synthesized voice.
 *
 * Mirrors apps/workers/message-consumer/src/processMessageJob.ts's
 * enforcement rules (entitlement checks before every paid-provider call,
 * reserve/claim/finalize outbound lifecycle) so voice and text messages
 * behave consistently -- with one deliberate difference: unlike text
 * messages (whose inbound row is already fully written by the webhook
 * handler before this function ever runs), download/storage/transcription
 * for a voice note happen *inside* this function, so the collaborative
 * ai_mode gate is applied only to the AI-reply half of this pipeline
 * (knowledge retrieval onward), not to ingestion/transcription -- a human
 * agent must be able to see the transcript regardless of ai_mode.
 */
export async function processVoiceJob(
  deps: VoiceConsumerDeps,
  payload: VoiceJobPayload,
): Promise<void> {
  const log = deps.logger.child({
    companyId: payload.companyId,
    conversationId: payload.conversationId,
  });
  const context = await deps.repo.loadConversationContext(payload.conversationId);

  // Usage metering (P0 usage repair): an inbound WhatsApp voice message was
  // received, independent of what the pipeline decides to do with it below
  // -- mirrors processMessageJob.ts's identical unconditional inbound-count
  // write. Idempotency key is keyed on the durable inbound messageId alone,
  // so a redelivered/retried queue job can never be double-counted.
  // Best-effort: a usage-write failure must never block real voice
  // processing.
  try {
    await deps.repo.recordUsageEvents([
      {
        companyId: payload.companyId,
        conversationId: payload.conversationId,
        metric: "whatsapp_inbound_messages",
        quantity: 1,
        idempotencyKey: `${payload.messageId}:whatsapp_inbound_messages`,
      },
    ]);
  } catch (error) {
    log.error("Failed to record inbound message usage", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "speech_to_text");
  } catch (error) {
    if (error instanceof EntitlementDeniedError) {
      log.warn("Blocked speech-to-text call: company not entitled", { reason: error.reason });
      // Voice isn't available on this plan/state at all -- tell the customer
      // rather than leaving their voice note unanswered.
      await sendTextNotice(
        deps,
        payload,
        context,
        log,
        "Voice messages aren't available on this account right now. Could you send that as text instead?",
      );
      return;
    }
    throw error;
  }

  const inboundStorageKey = buildStorageKey(payload.companyId, "audio/inbound", payload.messageId);
  const primaryLanguage =
    context.aiContext.enabledLanguages[0] ?? context.aiContext.fallbackLanguage;

  // Retry safety (voice pipeline reliability phase 4/5): payload.messageId
  // is the inbound `messages.id` row already created by the WhatsApp
  // webhook handler before this job was ever enqueued -- stable across
  // every Cloudflare Queue redelivery/retry of this same logical job (see
  // apps/api/src/whatsappWebhookHandler.ts). Checking for an
  // already-completed transcription FIRST, before touching WhatsApp media
  // download, R2 storage, or the paid STT provider at all, means a retried
  // job reuses prior progress instead of repeating it or creating a second
  // media_files row -- the exact duplicate-row bug this phase fixes.
  const existingTranscription = await deps.repo.findExistingTranscription({
    messageId: payload.messageId,
  });

  let transcription: SpeechToTextResult;
  let transcriptionReused: boolean;
  let sttDiagnostics: {
    mimeType: string;
    sizeBytes: number;
    requestedLanguageCode: string;
  } | null = null;

  if (existingTranscription) {
    transcription = {
      text: existingTranscription.rawText,
      detectedLanguageCode: existingTranscription.detectedLanguage,
      confidence: existingTranscription.languageConfidence,
    };
    transcriptionReused = true;
    log.info("Stage: stt_transcription", {
      reused: true,
      detectedLanguage: transcription.detectedLanguageCode,
      transcriptCharCount: transcription.text.length,
      confidence: transcription.confidence,
    });
  } else {
    const existingMedia = await deps.repo.findExistingInboundAudio({
      companyId: payload.companyId,
      messageId: payload.messageId,
    });

    let audioBytes: ArrayBuffer;
    let mimeType: string;
    let mediaFileId: string;
    let mediaReused = false;

    if (existingMedia) {
      const stored = await deps.storageProvider.get(inboundStorageKey);
      if (stored) {
        audioBytes = stored;
        mimeType = existingMedia.mimeType ?? payload.mimeType ?? "audio/ogg";
        mediaFileId = existingMedia.mediaFileId;
        mediaReused = true;
      } else {
        // Defensive fallback only -- the media_files row exists but the R2
        // object it points at is unexpectedly missing (retention deletion
        // runs on a much longer horizon than any queue retry window, so
        // this should not happen under normal operation).
        log.warn(
          "media_files row exists but the stored object is missing; re-downloading from WhatsApp",
          { mediaFileId: existingMedia.mediaFileId },
        );
        const media = await deps.whatsappProvider.getMediaMetadata(payload.mediaId);
        audioBytes = await deps.whatsappProvider.downloadMedia(media.url);
        mimeType = payload.mimeType ?? media.mimeType ?? "audio/ogg";
        await deps.storageProvider.put(inboundStorageKey, audioBytes, { contentType: mimeType });
        mediaFileId = existingMedia.mediaFileId;
      }
    } else {
      const media = await deps.whatsappProvider.getMediaMetadata(payload.mediaId);
      audioBytes = await deps.whatsappProvider.downloadMedia(media.url);
      mimeType = payload.mimeType ?? media.mimeType ?? "audio/ogg";

      await deps.storageProvider.put(inboundStorageKey, audioBytes, { contentType: mimeType });
      const inboundRetentionExpiresAt = computeRetentionExpiry(
        new Date(),
        context.voiceSettings.retentionDays,
      );
      const created = await deps.repo.recordInboundAudio({
        companyId: payload.companyId,
        messageId: payload.messageId,
        storageKey: inboundStorageKey,
        mimeType,
        sizeBytes: audioBytes.byteLength,
        providerMediaId: payload.mediaId,
        retentionExpiresAt: inboundRetentionExpiresAt,
      });
      mediaFileId = created.mediaFileId;
    }

    log.info("Stage: media_download", {
      reused: mediaReused,
      mimeType,
      sizeBytes: audioBytes.byteLength,
    });

    // "Confidently Malayalam" means the company has no other enabled
    // language to be mixed with -- there's no ambiguity to auto-detect. Any
    // company with more than one enabled language (e.g. Malayalam-English)
    // is treated as potentially mixed: auto-detect plus keyterms gives
    // better accuracy there than forcing a single language would.
    const isConfidentlyMalayalam =
      context.aiContext.enabledLanguages.length === 1 &&
      context.aiContext.enabledLanguages[0] === "ml";
    // Sanitized at assembly time (not just relying on the provider's own
    // defensive re-check) so a future edit to MALAYALAM_STT_KEYTERMS -- or
    // any other future source of keyterms -- can never reintroduce the
    // 2026-08-04 incident (an oversized/malformed term making the entire
    // STT request fail). Only safe counts are logged, never the terms
    // themselves.
    const keytermCandidates = isConfidentlyMalayalam ? [] : MALAYALAM_STT_KEYTERMS;
    const { keyterms: sanitizedKeyterms, summary: keytermSummary } =
      sanitizeKeyterms(keytermCandidates);
    if (keytermSummary.rejectedCount > 0) {
      log.warn("Dropped invalid STT keyterms before request", {
        inputCount: keytermSummary.inputCount,
        acceptedCount: keytermSummary.acceptedCount,
        rejectedCount: keytermSummary.rejectedCount,
        rejectionReasons: keytermSummary.rejectionReasons,
      });
    }

    const sttInput = {
      audio: audioBytes,
      mimeType,
      languageCode: toSttLanguageCode(primaryLanguage),
      alternativeLanguageCodes: context.aiContext.enabledLanguages
        .slice(1)
        .map((code) => toSttLanguageCode(code)),
      forceLanguageCode: isConfidentlyMalayalam ? "ml" : undefined,
      keyterms: sanitizedKeyterms.length > 0 ? sanitizedKeyterms : undefined,
    };
    sttDiagnostics = {
      mimeType,
      sizeBytes: audioBytes.byteLength,
      requestedLanguageCode: sttInput.languageCode,
    };

    let freshTranscription: SpeechToTextResult;
    try {
      freshTranscription = await deps.sttProvider.transcribe(sttInput);
      if (
        !freshTranscription.text.trim() &&
        context.voiceSettings.fallbackBehavior === "retry_once"
      ) {
        freshTranscription = await deps.sttProvider.transcribe(sttInput);
      }
    } catch (error) {
      // Non-retryable provider/configuration failures (bad credential,
      // malformed request) will fail identically on every future retry --
      // recording a durable failure and returning normally (so the caller
      // acks rather than retries) avoids burning the queue's remaining
      // retry budget on calls guaranteed to fail again (PHASE 5/12).
      // Retryable failures (timeout, 429, 5xx, network) are rethrown so the
      // existing Cloudflare Queue retry mechanism handles them -- no new
      // retry loop is introduced here.
      if (error instanceof ElevenLabsProviderError && !error.retryable) {
        await deps.repo.recordJobFailure({
          companyId: payload.companyId,
          queueName: deps.queueName,
          jobId: payload.jobId,
          correlationId: payload.correlationId,
          messageId: payload.messageId,
          stage: "stt_transcription",
          attempt: payload.attempt,
          category: error.category,
          retryable: false,
          errorSummary: `ElevenLabs speech-to-text failed: ${error.category} (status ${error.status})`,
        });
        log.error("Non-retryable speech-to-text failure; recorded and stopping", {
          category: error.category,
          status: error.status,
        });
        return;
      }
      throw error;
    }

    transcription = freshTranscription;
    transcriptionReused = false;
    log.info("Stage: stt_transcription", {
      reused: false,
      detectedLanguage: transcription.detectedLanguageCode,
      transcriptCharCount: transcription.text.length,
      confidence: transcription.confidence,
    });

    await deps.repo.recordTranscription({
      companyId: payload.companyId,
      messageId: payload.messageId,
      mediaFileId,
      provider: deps.sttProvider.providerName,
      rawText: transcription.text,
      detectedLanguage: transcription.detectedLanguageCode,
      languageConfidence: transcription.confidence,
    });
  }

  // Media download, storage, and transcription above always run, regardless
  // of ai_mode -- a human agent must be able to see what the customer said
  // even while AI is paused (Human Handover Inbox final plan section 5: AI
  // being paused stops *replies*, never ingestion). Everything from here
  // down -- the empty-transcript notice/escalation, and the full knowledge
  // retrieval -> Claude -> WhatsApp reply pipeline -- is the actual AI-reply
  // path, so it's the one gated by isAiReplyAllowed. Moved here (from
  // immediately after loadConversationContext) after a staging incident
  // where the old placement skipped the transcript entirely for every voice
  // note received while ai_mode='paused'.
  if (!isAiReplyAllowed(context.conversationState, context.aiMode)) {
    log.info(
      "Skipping AI reply: suppressed by conversation state or ai_mode (transcript already recorded)",
      {
        state: context.conversationState,
        aiMode: context.aiMode,
      },
    );
    return;
  }

  if (!transcription.text.trim()) {
    const diagnostics = {
      detectedLanguageCode: transcription.detectedLanguageCode,
      confidence: transcription.confidence,
      transcriptionReused,
      ...(sttDiagnostics ?? {}),
    };
    if (context.voiceSettings.fallbackBehavior === "escalate") {
      await triggerHandoverAtomic(deps.handoverRepo, {
        conversationId: payload.conversationId,
        reason: "speech_to_text_failed",
        sourceMessageId: payload.messageId,
        sourceType: "voice",
      });
      log.warn("Speech-to-text produced no transcript; escalated to a human", diagnostics);
    } else {
      log.warn("Speech-to-text produced no transcript; sent a text-only notice", diagnostics);
    }

    await sendTextNotice(
      deps,
      payload,
      context,
      log,
      "Sorry, I couldn't understand that voice note clearly. Could you try again, or send it as text?",
    );
    return;
  }

  // Unicode NFC normalization matters for scripts like Malayalam, whose
  // conjunct consonants/vowel signs can arrive as more than one equivalent
  // combining-code-point sequence -- normalizing here (not just trimming)
  // keeps the transcript's representation consistent regardless of which
  // language was spoken.
  const normalizedTranscript = normalizeTranscript(transcription.text);
  log.info("Stage: transcript_normalization", {
    detectedLanguage: transcription.detectedLanguageCode,
    transcriptCharCount: normalizedTranscript.length,
  });

  const knowledge = await deps.knowledgeRetriever.retrieve(payload.companyId, normalizedTranscript);

  log.info("Stage: claude_request", {
    detectedLanguage: transcription.detectedLanguageCode,
    transcriptCharCount: normalizedTranscript.length,
  });

  const { response, usedFallback, repaired, usage } = await generateValidatedResponse(
    {
      provider: deps.aiProvider,
      onValidationFailure: (details) =>
        log.error("AI structured response failed validation twice", {
          detectedLanguage: transcription.detectedLanguageCode,
          firstResponseCharCount: details.rawFirstAttempt.length,
          repairResponseCharCount: details.rawRepairAttempt.length,
        }),
      onDiagnostics: (event: ValidationDiagnosticEvent) =>
        log.info(`Stage: ${event.stage}`, {
          attempt: event.attempt,
          detectedLanguage: event.detectedLanguage,
          transcriptCharCount: event.transcriptCharCount,
          responseCharCount: event.responseCharCount,
          category: event.category,
          failedField: event.failedField,
          repairAttempted: event.repairAttempted,
          repairSucceeded: event.repairSucceeded,
        }),
    },
    {
      company: context.aiContext,
      memory: context.memory,
      knowledge,
      customerMessage: normalizedTranscript,
      currentDetectedLanguage: transcription.detectedLanguageCode,
      temporal: context.temporal,
    },
  );

  // Usage metering (P0 usage repair): generateValidatedResponse returning at
  // all means a real provider.generate() round trip completed and consumed
  // real, billable tokens -- see processMessageJob.ts's identical write for
  // the full rationale. Idempotency key is keyed on the durable inbound
  // messageId, so a queue retry that re-runs this job can never
  // double-count. Best-effort.
  try {
    await recordAiUsage(deps.repo, {
      companyId: payload.companyId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      usage,
      requestCount: repaired ? 2 : 1,
      requestSucceeded: true,
    });
  } catch (error) {
    log.error("Failed to record AI usage", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const handoverTriggered = response.requiresHuman;
  log.info("Stage: safety_validation", {
    detectedLanguage: transcription.detectedLanguageCode,
    responseCharCount: response.answer.length,
    repairAttempted: repaired,
    usedFallback,
    handoverTriggered,
  });

  if (usedFallback) {
    log.warn("Used safe static fallback response after repeated AI validation failure");
  }

  if (handoverTriggered) {
    const reason = response.handoverReason ?? "ai_requested_handover";
    log.warn("Triggering handover (AI keeps replying collaboratively unless explicitly paused)", {
      reason,
    });
    await triggerHandoverAtomic(deps.handoverRepo, {
      conversationId: payload.conversationId,
      reason,
      sourceMessageId: payload.messageId,
      sourceType: "voice",
    });
  }

  if (response.leadUpdates) {
    await deps.repo.applyLeadUpdates({
      companyId: payload.companyId,
      conversationId: payload.conversationId,
      leadUpdates: response.leadUpdates,
    });
  }

  try {
    await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "whatsapp_send");
  } catch (error) {
    if (error instanceof EntitlementDeniedError) {
      log.warn("Blocked WhatsApp send: company not entitled", { reason: error.reason });
      return;
    }
    throw error;
  }

  const entitlementSnapshot = await deps.entitlementRepo.getSnapshot(payload.companyId);
  const voiceFeature = entitlementSnapshot.features.voice_enabled;
  const voiceLimit =
    voiceFeature?.numericLimit ??
    entitlementSnapshot.features.monthly_voice_minutes?.numericLimit ??
    null;
  const voiceUsed = entitlementSnapshot.usage.monthly_voice_minutes ?? 0;

  const replyMode = resolveReplyMode({
    incomingMessageType: "audio",
    companyDefaultReplyMode: context.voiceSettings.replyMode,
    contactPreference:
      (context.memory.customerReplyPreference as
        "text_only" | "voice_only" | "text_and_voice" | "auto" | null) ?? null,
    voiceEnabledForCompany: context.voiceSettings.isEnabled,
    voiceEntitledByPlan: voiceFeature?.isEnabled ?? false,
    voiceUsageHeadroomAvailable: voiceLimit === null || voiceUsed < voiceLimit,
    isSuspended:
      entitlementSnapshot.companyStatus === "suspended" ||
      entitlementSnapshot.companyStatus === "manually_suspended",
    voiceProviderAvailable: true,
  });

  if (replyMode.downgraded) {
    log.warn("Voice reply downgraded to text_only", { reason: replyMode.downgradeReason });
  }

  const replyLanguage = transcription.detectedLanguageCode ?? primaryLanguage;
  // The voice used for TTS is decided by the reply's own dominant script,
  // not just the STT-detected language tag -- a Malayalam-English mixed
  // reply where Malayalam dominates must still use the Malayalam voice
  // (final plan section 4). The Malayalam TTS-preparation layer (numbers/
  // currency spoken aloud, Markdown/bullets stripped, NFC-normalized) is
  // applied only for that voice; the WhatsApp text reply above always keeps
  // response.answer completely unchanged.
  const ttsIsMalayalam = isDominantlyMalayalam(response.answer);
  const ttsLanguageCode = ttsIsMalayalam ? "ml" : "en";
  const speechText = ttsIsMalayalam ? prepareMalayalamSpeechText(response.answer) : response.answer;

  // The deployment-wide VOICE_REPLY_MODE switch overrides the per-company/
  // contact resolveReplyMode() result when set to "text_only" -- every voice
  // job replies with text alone, regardless of language or company config.
  // "text_and_audio" leaves resolveReplyMode()'s result untouched.
  const audioForcedOff = deps.voiceReplyMode === "text_only";
  const effectiveReplyMode = audioForcedOff ? "text_only" : replyMode.mode;

  let textReplySent = false;
  if (effectiveReplyMode === "text_only" || effectiveReplyMode === "text_and_voice") {
    log.info("Stage: whatsapp_text_generation", {
      detectedLanguage: replyLanguage,
      responseCharCount: response.answer.length,
    });
    const outboundResult = await sendAiOutboundMessage(deps.handoverRepo, deps.whatsappProvider, {
      sourceMessageId: payload.messageId,
      channelType: "text",
      phoneNumberId: context.phoneNumberId,
      toWaId: context.waId,
      body: response.answer,
    });
    if (outboundResult.alreadyHandled) {
      log.info("Skipped text reply send: already reserved/sent for this message", {
        outboundStatus: outboundResult.outboundStatus,
      });
    } else if (outboundResult.outboundStatus === "sent") {
      // Usage metering (P0 usage repair): a genuinely new outbound text
      // reply was just sent for this voice note -- see
      // processMessageJob.ts's identical write for the full rationale.
      // Idempotency key is keyed on the outbound message's own id (stable
      // per (source_message_id, channel_type)). Best-effort.
      try {
        await deps.repo.recordUsageEvents([
          {
            companyId: payload.companyId,
            conversationId: payload.conversationId,
            metric: "whatsapp_outbound_messages",
            quantity: 1,
            idempotencyKey: `${outboundResult.messageId}:whatsapp_outbound_messages`,
          },
        ]);
      } catch (error) {
        log.error("Failed to record outbound text message usage", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    textReplySent = true;
  }

  const shouldSendAudio =
    effectiveReplyMode === "voice_only" || effectiveReplyMode === "text_and_voice";

  // Sanitized: never log the customer phone number, full transcript, or full
  // AI response -- only channel/mode/flags.
  log.info("Voice reply summary", {
    inboundChannel: "voice",
    replyMode: deps.voiceReplyMode,
    transcriptionCompleted: Boolean(transcription.text.trim()),
    textReplySent,
    audioReplySkipped: !shouldSendAudio,
    ...(audioForcedOff ? { skipReason: "reply_mode_text_only" } : {}),
  });

  if (shouldSendAudio) {
    // Reserved before synthesizing (rather than using sendAiOutboundMessage's
    // generic helper) so a redelivered job that already produced a voice
    // reply for this message skips the paid TTS/upload work entirely instead
    // of only skipping the final WhatsApp send.
    const audioReservation = await deps.handoverRepo.reserveAiOutboundMessage(
      payload.messageId,
      "audio",
    );
    if (!audioReservation.claimed) {
      log.info("Skipped voice reply synthesis: already reserved/sent for this message", {
        outboundStatus: audioReservation.outboundStatus,
      });
      return;
    }

    try {
      await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "text_to_speech");

      log.info("Stage: whatsapp_audio_generation", {
        detectedLanguage: replyLanguage,
        ttsLanguageCode,
        responseCharCount: response.answer.length,
        speechTextCharCount: speechText.length,
      });
      const voiceId = context.voiceSettings.defaultVoiceByLanguage[ttsLanguageCode] ?? undefined;
      const synthesized = await deps.ttsProvider.synthesize({
        text: speechText,
        languageCode: ttsLanguageCode,
        voiceId,
        speakingRate: context.voiceSettings.speakingRate,
      });

      // Usage metering (P0 usage repair): text_to_speech_characters is the
      // one voice usage dimension precisely and honestly knowable here --
      // the exact character count just sent to the TTS provider, no
      // provider-returned or decoded metadata required. speech_to_text_seconds
      // and generated_voice_seconds are deliberately NOT recorded: neither
      // ElevenLabs' STT/TTS REST responses nor WhatsApp's media metadata
      // return audio duration, and no audio-container decoder exists in
      // this codebase -- fabricating one from file byte size was explicitly
      // out of scope for this repair (see PHASE 6 of the P0 usage-repair
      // task). Idempotency key is keyed on the durable inbound messageId.
      // Best-effort.
      try {
        await deps.repo.recordUsageEvents([
          {
            companyId: payload.companyId,
            conversationId: payload.conversationId,
            metric: "text_to_speech_characters",
            quantity: speechText.length,
            idempotencyKey: `${payload.messageId}:text_to_speech_characters`,
          },
        ]);
      } catch (error) {
        log.error("Failed to record text-to-speech usage", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const { mediaId: outboundMediaId } = await deps.whatsappProvider.uploadMedia(
        context.phoneNumberId,
        synthesized.audio,
        synthesized.mimeType,
      );
      const sendResult = await deps.whatsappProvider.sendAudio({
        phoneNumberId: context.phoneNumberId,
        toWaId: context.waId,
        audioMediaIdOrUrl: outboundMediaId,
      });

      const outboundStorageKey = buildStorageKey(
        payload.companyId,
        "audio/outbound",
        crypto.randomUUID(),
      );
      await deps.storageProvider.put(outboundStorageKey, synthesized.audio, {
        contentType: synthesized.mimeType,
      });

      await deps.handoverRepo.finalizeAiOutboundMessage(
        audioReservation.id,
        "sent",
        sendResult.providerMessageId,
        response.answer,
      );

      // Usage metering (P0 usage repair): a genuinely new outbound audio
      // reply was just sent -- mirrors the text-reply write above, keyed on
      // this audio message's own stable id (audioReservation.id, distinct
      // per (source_message_id, "audio")) so it can never collide with the
      // text reply's own key for the same voice note. Best-effort.
      try {
        await deps.repo.recordUsageEvents([
          {
            companyId: payload.companyId,
            conversationId: payload.conversationId,
            metric: "whatsapp_outbound_messages",
            quantity: 1,
            idempotencyKey: `${audioReservation.id}:whatsapp_outbound_messages`,
          },
        ]);
      } catch (error) {
        log.error("Failed to record outbound audio message usage", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await deps.repo.recordGeneratedAudioMetadata({
        companyId: payload.companyId,
        messageId: audioReservation.id,
        storageKey: outboundStorageKey,
        mimeType: synthesized.mimeType,
        sizeBytes: synthesized.audio.byteLength,
        durationSeconds: null,
        voiceId: voiceId ?? null,
        language: ttsLanguageCode,
        sourceText: speechText,
        // Real provider identity, never hardcoded -- see
        // TextToSpeechProvider.providerName's doc comment (this fixes a
        // pre-existing bug: generated_audio.provider was previously
        // hardcoded to "google" regardless of which provider actually ran).
        provider: deps.ttsProvider.providerName,
        retentionExpiresAt: computeRetentionExpiry(new Date(), context.voiceSettings.retentionDays),
      });
    } catch (error) {
      if (error instanceof EntitlementDeniedError) {
        log.warn("Blocked text-to-speech call: company not entitled", { reason: error.reason });
        return;
      }
      // A TTS/upload/send failure here must not throw: the text reply above
      // (if this mode included one) has already been sent. Rethrowing would
      // fail the whole queue job and cause a retry that re-runs everything
      // from the top -- including re-transcribing the audio. Classify and
      // finalize the audio reservation instead, mirroring sendAiOutboundMessage.
      const classification = classifySendError(error);
      await deps.handoverRepo.finalizeAiOutboundMessage(
        audioReservation.id,
        classification.status,
        null,
        null,
        classification.errorCode,
        classification.retryable,
      );
      log.error("Voice reply failed; text-only reply (if any) already sent", {
        outboundStatus: classification.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
