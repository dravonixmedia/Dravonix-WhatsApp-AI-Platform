import { generateValidatedResponse, type AiProvider } from "@dravonix/ai";
import { assertCompanyMayUseProvider, type EntitlementRepository } from "@dravonix/billing";
import { EntitlementDeniedError, isAiReplyAllowed } from "@dravonix/core";
import type { KnowledgeRetriever } from "@dravonix/knowledge";
import { logHandoverTrigger, type Logger } from "@dravonix/observability";
import {
  isDominantlyMalayalam,
  isMalayalamLanguageCode,
  resolveReplyMode,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
} from "@dravonix/speech";
import { buildStorageKey, computeRetentionExpiry, type StorageProvider } from "@dravonix/storage";
import type { WhatsAppProvider } from "@dravonix/whatsapp";
import type { VoiceConsumerRepository } from "./repository.js";

export interface VoiceJobPayload {
  companyId: string;
  conversationId: string;
  messageId: string;
  waId: string;
  mediaId: string;
  mimeType: string | null;
}

export interface VoiceConsumerDeps {
  repo: VoiceConsumerRepository;
  entitlementRepo: EntitlementRepository;
  knowledgeRetriever: KnowledgeRetriever;
  aiProvider: AiProvider;
  whatsappProvider: WhatsAppProvider;
  sttProvider: SpeechToTextProvider;
  ttsProvider: TextToSpeechProvider;
  storageProvider: StorageProvider;
  logger: Logger;
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
 * Runs a post-send bookkeeping write (recording that a message was sent) and
 * swallows any failure instead of letting it propagate. The WhatsApp send
 * this follows has already irreversibly happened -- if this rethrew, the
 * whole queue job would fail and retry, re-running everything from the top
 * (including a fresh Claude call) and sending the customer a real duplicate
 * message for a failure that's specific to our own bookkeeping, not the send.
 */
async function recordOutboundSafely(log: Logger, record: () => Promise<void>): Promise<void> {
  try {
    await record();
  } catch (error) {
    log.error("Failed to record an outbound message that was already sent to the customer", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Processes a single inbound voice note end to end: download the audio from
 * WhatsApp -> store it -> transcribe -> (same AI pipeline as text messages) ->
 * resolve reply mode -> reply with text and/or synthesized voice.
 *
 * Mirrors apps/workers/message-consumer/src/processMessageJob.ts's structure
 * and enforcement rules (ai_active gating, entitlement checks before every
 * paid-provider call) so voice and text messages behave consistently.
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

  if (!isAiReplyAllowed(context.conversationState)) {
    log.info("Skipping AI reply: conversation is not in ai_active state", {
      state: context.conversationState,
    });
    return;
  }

  try {
    await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "speech_to_text");
  } catch (error) {
    if (error instanceof EntitlementDeniedError) {
      log.warn("Blocked speech-to-text call: company not entitled", { reason: error.reason });
      // Voice isn't available on this plan/state at all -- tell the customer
      // rather than leaving their voice note unanswered (unless WhatsApp
      // sending itself is also blocked, e.g. a suspended company).
      try {
        await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "whatsapp_send");
      } catch (sendError) {
        if (sendError instanceof EntitlementDeniedError) return;
        throw sendError;
      }
      const notice =
        "Voice messages aren't available on this account right now. Could you send that as text instead?";
      const sendResult = await deps.whatsappProvider.sendText({
        phoneNumberId: context.phoneNumberId,
        toWaId: context.waId,
        body: notice,
      });
      await recordOutboundSafely(log, () =>
        deps.repo.recordOutboundTextMessage({
          companyId: payload.companyId,
          conversationId: payload.conversationId,
          body: notice,
          providerMessageId: sendResult.providerMessageId,
        }),
      );
      return;
    }
    throw error;
  }

  const media = await deps.whatsappProvider.getMediaMetadata(payload.mediaId);
  const audioBytes = await deps.whatsappProvider.downloadMedia(media.url);
  const mimeType = payload.mimeType ?? media.mimeType ?? "audio/ogg";

  const inboundStorageKey = buildStorageKey(payload.companyId, "audio/inbound", payload.messageId);
  await deps.storageProvider.put(inboundStorageKey, audioBytes, { contentType: mimeType });
  const inboundRetentionExpiresAt = computeRetentionExpiry(
    new Date(),
    context.voiceSettings.retentionDays,
  );
  const { mediaFileId } = await deps.repo.recordInboundAudio({
    companyId: payload.companyId,
    messageId: payload.messageId,
    storageKey: inboundStorageKey,
    mimeType,
    sizeBytes: audioBytes.byteLength,
    providerMediaId: payload.mediaId,
    retentionExpiresAt: inboundRetentionExpiresAt,
  });

  const primaryLanguage =
    context.aiContext.enabledLanguages[0] ?? context.aiContext.fallbackLanguage;
  const sttInput = {
    audio: audioBytes,
    mimeType,
    languageCode: toSttLanguageCode(primaryLanguage),
    alternativeLanguageCodes: context.aiContext.enabledLanguages
      .slice(1)
      .map((code) => toSttLanguageCode(code)),
  };

  let transcription = await deps.sttProvider.transcribe(sttInput);
  let sttAttemptCount = 1;

  if (!transcription.text.trim() && context.voiceSettings.fallbackBehavior === "retry_once") {
    transcription = await deps.sttProvider.transcribe(sttInput);
    sttAttemptCount = 2;
  }

  await deps.repo.recordTranscription({
    companyId: payload.companyId,
    messageId: payload.messageId,
    mediaFileId,
    provider: deps.sttProvider.providerName,
    rawText: transcription.text,
    detectedLanguage: transcription.detectedLanguageCode,
    languageConfidence: transcription.confidence,
  });

  if (!transcription.text.trim()) {
    const diagnostics = {
      detectedLanguageCode: transcription.detectedLanguageCode,
      confidence: transcription.confidence,
      requestedLanguageCode: sttInput.languageCode,
      mimeType,
      sizeBytes: audioBytes.byteLength,
    };
    if (context.voiceSettings.fallbackBehavior === "escalate") {
      logHandoverTrigger(log, {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        reasonCode: "speech_to_text_failed",
        source: "voice_failure",
        validationAttemptCount: sttAttemptCount,
        previousState: context.conversationState,
      });
      await deps.repo.triggerHandover({
        conversationId: payload.conversationId,
        reason: "speech_to_text_failed",
      });
      log.warn("Speech-to-text produced no transcript; escalated to a human", diagnostics);
    } else {
      log.warn("Speech-to-text produced no transcript; sent a text-only notice", diagnostics);
    }

    try {
      await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "whatsapp_send");
    } catch (error) {
      if (error instanceof EntitlementDeniedError) return;
      throw error;
    }
    const notice =
      "Sorry, I couldn't understand that voice note clearly. Could you try again, or send it as text?";
    const sendResult = await deps.whatsappProvider.sendText({
      phoneNumberId: context.phoneNumberId,
      toWaId: context.waId,
      body: notice,
    });
    await recordOutboundSafely(log, () =>
      deps.repo.recordOutboundTextMessage({
        companyId: payload.companyId,
        conversationId: payload.conversationId,
        body: notice,
        providerMessageId: sendResult.providerMessageId,
      }),
    );
    return;
  }

  const knowledge = await deps.knowledgeRetriever.retrieve(payload.companyId, transcription.text);

  const { response, usedFallback, repaired } = await generateValidatedResponse(
    {
      provider: deps.aiProvider,
      onValidationFailure: (details) =>
        log.error("AI structured response failed validation twice", details),
    },
    {
      company: context.aiContext,
      memory: context.memory,
      knowledge,
      customerMessage: transcription.text,
      currentMessageChannel: "audio",
    },
  );

  if (usedFallback) {
    log.warn("Used safe static fallback response after repeated AI validation failure");
  }

  if (response.requiresHuman) {
    const reasonCode = response.handoverReason ?? "ai_requested_handover";
    logHandoverTrigger(log, {
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      reasonCode,
      source: usedFallback ? "validation_fallback" : "claude",
      validationAttemptCount: repaired ? 2 : 1,
      previousState: context.conversationState,
    });
    await deps.repo.triggerHandover({
      conversationId: payload.conversationId,
      reason: reasonCode,
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
  // Voice/model selection uses only the current inbound message's detected
  // language and the current generated reply's own script -- never stale
  // conversation history -- so a Malayalam-English mixed reply where
  // Malayalam dominates still gets the Malayalam voice.
  const ttsIsMalayalam =
    isMalayalamLanguageCode(transcription.detectedLanguageCode) ||
    isDominantlyMalayalam(response.answer);
  const ttsLanguageCode = ttsIsMalayalam ? "ml" : replyLanguage;

  if (replyMode.mode === "text_only" || replyMode.mode === "text_and_voice") {
    const sendResult = await deps.whatsappProvider.sendText({
      phoneNumberId: context.phoneNumberId,
      toWaId: context.waId,
      body: response.answer,
    });
    await recordOutboundSafely(log, () =>
      deps.repo.recordOutboundTextMessage({
        companyId: payload.companyId,
        conversationId: payload.conversationId,
        body: response.answer,
        providerMessageId: sendResult.providerMessageId,
      }),
    );
  }

  if (replyMode.mode === "voice_only" || replyMode.mode === "text_and_voice") {
    try {
      await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "text_to_speech");

      const voiceId = context.voiceSettings.defaultVoiceByLanguage[ttsLanguageCode] ?? undefined;
      const synthesized = await deps.ttsProvider.synthesize({
        text: response.answer,
        languageCode: ttsLanguageCode,
        voiceId,
        speakingRate: context.voiceSettings.speakingRate,
      });

      // Sanitized: never log the actual voice ID, API key, transcript, full
      // response text, or customer phone number.
      log.info("Selected TTS voice configuration", {
        selectedLanguage: ttsLanguageCode,
        voiceCategory: synthesized.voiceCategory,
        modelId: synthesized.modelId,
        fallbackVoiceUsed: synthesized.fallbackVoiceUsed ?? false,
      });

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

      await deps.repo.recordOutboundVoiceMessage({
        companyId: payload.companyId,
        conversationId: payload.conversationId,
        body: response.answer,
        providerMessageId: sendResult.providerMessageId,
        storageKey: outboundStorageKey,
        mimeType: synthesized.mimeType,
        sizeBytes: synthesized.audio.byteLength,
        durationSeconds: null,
        voiceId: voiceId ?? null,
        language: ttsLanguageCode,
        retentionExpiresAt: computeRetentionExpiry(new Date(), context.voiceSettings.retentionDays),
      });
    } catch (error) {
      if (error instanceof EntitlementDeniedError) {
        log.warn("Blocked text-to-speech call: company not entitled", { reason: error.reason });
        return;
      }
      // A TTS provider failure here must not throw: the text reply above (if
      // this mode included one) has already been sent and recorded. Rethrowing
      // would fail the whole queue job and cause a retry that re-runs
      // everything from the top -- including re-transcribing the audio and
      // re-sending that same text reply again, duplicating it to the customer
      // for a failure that's specific to voice synthesis. Degrade to the
      // text-only outcome instead.
      log.error("Text-to-speech failed; falling back to the text-only reply already sent", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }
}
