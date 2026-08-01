import { generateValidatedResponse, type AiProvider } from "@dravonix/ai";
import { assertCompanyMayUseProvider, type EntitlementRepository } from "@dravonix/billing";
import { EntitlementDeniedError, isAiReplyAllowed } from "@dravonix/core";
import type { KnowledgeRetriever } from "@dravonix/knowledge";
import type { Logger } from "@dravonix/observability";
import {
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
      await deps.repo.recordOutboundTextMessage({
        companyId: payload.companyId,
        conversationId: payload.conversationId,
        body: notice,
        providerMessageId: sendResult.providerMessageId,
      });
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

  if (!transcription.text.trim() && context.voiceSettings.fallbackBehavior === "retry_once") {
    transcription = await deps.sttProvider.transcribe(sttInput);
  }

  await deps.repo.recordTranscription({
    companyId: payload.companyId,
    messageId: payload.messageId,
    mediaFileId,
    provider: "google",
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
    await deps.repo.recordOutboundTextMessage({
      companyId: payload.companyId,
      conversationId: payload.conversationId,
      body: notice,
      providerMessageId: sendResult.providerMessageId,
    });
    return;
  }

  const knowledge = await deps.knowledgeRetriever.retrieve(payload.companyId, transcription.text);

  const { response, usedFallback } = await generateValidatedResponse(
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
    },
  );

  if (usedFallback) {
    log.warn("Used safe static fallback response after repeated AI validation failure");
  }

  if (response.requiresHuman) {
    await deps.repo.triggerHandover({
      conversationId: payload.conversationId,
      reason: response.handoverReason ?? "ai_requested_handover",
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

  if (replyMode.mode === "text_only" || replyMode.mode === "text_and_voice") {
    const sendResult = await deps.whatsappProvider.sendText({
      phoneNumberId: context.phoneNumberId,
      toWaId: context.waId,
      body: response.answer,
    });
    await deps.repo.recordOutboundTextMessage({
      companyId: payload.companyId,
      conversationId: payload.conversationId,
      body: response.answer,
      providerMessageId: sendResult.providerMessageId,
    });
  }

  if (replyMode.mode === "voice_only" || replyMode.mode === "text_and_voice") {
    try {
      await assertCompanyMayUseProvider(deps.entitlementRepo, payload.companyId, "text_to_speech");

      const voiceId = context.voiceSettings.defaultVoiceByLanguage[replyLanguage] ?? undefined;
      const synthesized = await deps.ttsProvider.synthesize({
        text: response.answer,
        languageCode: replyLanguage,
        voiceId,
        speakingRate: context.voiceSettings.speakingRate,
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
        language: replyLanguage,
        retentionExpiresAt: computeRetentionExpiry(new Date(), context.voiceSettings.retentionDays),
      });
    } catch (error) {
      if (error instanceof EntitlementDeniedError) {
        log.warn("Blocked text-to-speech call: company not entitled", { reason: error.reason });
        return;
      }
      throw error;
    }
  }
}
