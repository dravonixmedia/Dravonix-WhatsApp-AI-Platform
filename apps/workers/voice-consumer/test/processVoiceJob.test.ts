import { MockAiProvider } from "@dravonix/ai";
import type { EntitlementRepository, EntitlementSnapshot } from "@dravonix/billing";
import type { ConversationState } from "@dravonix/core";
import type {
  HandoverWorkerRepository,
  MessageChannelType,
  OutboundDeliveryStatus,
} from "@dravonix/handover";
import { createLogger } from "@dravonix/observability";
import { MockSpeechToTextProvider, MockTextToSpeechProvider } from "@dravonix/speech";
import { MockStorageProvider } from "@dravonix/storage";
import { MockWhatsAppProvider } from "@dravonix/whatsapp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processVoiceJob,
  type VoiceConsumerDeps,
  type VoiceJobPayload,
} from "../src/processVoiceJob.js";
import type { VoiceConsumerRepository, VoiceConversationContext } from "../src/repository.js";

const COMPANY_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const CONVERSATION_ID = "conv-1";

const silentLogger = createLogger({ environment: "test" }, { write: () => {} });

function baseConversationContext(
  overrides: Partial<VoiceConversationContext> = {},
): VoiceConversationContext {
  return {
    companyId: COMPANY_ID,
    conversationState: "ai_active",
    aiMode: "active",
    aiContext: {
      companyId: COMPANY_ID,
      companyName: "Dravonix Media",
      botName: "Dravonix Assistant",
      tone: "friendly",
      enabledLanguages: ["en"],
      fallbackLanguage: "en",
      approvedServices: [],
      approvedProducts: [],
      pricingRules: [],
      businessHours: null,
      policies: [],
      faqs: [],
      restrictedTopics: [],
      requiredDisclaimers: [],
      handoverRules: [],
      confidenceThreshold: 0.55,
      staticFallbackMessage: "Automated assistance is temporarily unavailable.",
      voiceEnabled: true,
    },
    memory: {
      recentMessages: [],
      summary: null,
      leadState: {},
      unresolvedQuestions: [],
      customerReplyPreference: null,
      lastDetectedLanguage: null,
    },
    waId: "919820000001",
    phoneNumberId: "TEST_PHONE_NUMBER_ID",
    voiceSettings: {
      isEnabled: true,
      defaultVoiceByLanguage: { en: "en-US-Neural2-C" },
      speakingRate: 1.0,
      maxReplyDurationSeconds: 60,
      maxIncomingDurationSeconds: 180,
      replyMode: "auto",
      retentionDays: 30,
      fallbackBehavior: "escalate",
    },
    ...overrides,
  };
}

function activeEntitlementSnapshot(
  overrides: Partial<EntitlementSnapshot> = {},
): EntitlementSnapshot {
  return {
    companyStatus: "active",
    subscriptionState: "active",
    features: { voice_enabled: { isEnabled: true, numericLimit: null } },
    usage: { monthly_voice_minutes: 0 },
    ...overrides,
  };
}

class FakeEntitlementRepository implements EntitlementRepository {
  constructor(private readonly snapshot: EntitlementSnapshot) {}
  getSnapshot = vi.fn(async (_companyId: string) => this.snapshot);
}

class FakeVoiceConsumerRepository implements VoiceConsumerRepository {
  context: VoiceConversationContext = baseConversationContext();
  recordedInboundAudio: unknown[] = [];
  recordedTranscriptions: unknown[] = [];
  recordedGeneratedAudio: unknown[] = [];
  appliedLeadUpdates: unknown[] = [];

  async loadConversationContext(_conversationId: string): Promise<VoiceConversationContext> {
    return this.context;
  }

  async recordInboundAudio(input: unknown): Promise<{ mediaFileId: string }> {
    this.recordedInboundAudio.push(input);
    return { mediaFileId: "media-file-1" };
  }

  async recordTranscription(input: unknown): Promise<void> {
    this.recordedTranscriptions.push(input);
  }

  async recordGeneratedAudioMetadata(input: unknown): Promise<void> {
    this.recordedGeneratedAudio.push(input);
  }

  async applyLeadUpdates(input: { leadUpdates: unknown }): Promise<void> {
    this.appliedLeadUpdates.push(input.leadUpdates);
  }
}

interface FakeOutboundMessage {
  outboundStatus: OutboundDeliveryStatus;
  providerMessageId: string | null;
}

/**
 * In-memory double for HandoverWorkerRepository, mirroring
 * apps/workers/message-consumer/test/processMessageJob.test.ts's fake --
 * replicates the claim-guard semantics closely enough to test the
 * collaborative AI-reply suppression rules and the exactly-once-per-message-
 * per-channel send guarantee (final plan section 12), including that a
 * redelivery skips paid TTS synthesis entirely, not just the WhatsApp send.
 */
class FakeHandoverWorkerRepository implements HandoverWorkerRepository {
  handoverCalls: Array<{
    conversationId: string;
    reason: string;
    sourceMessageId: string | null;
    sourceType: string;
  }> = [];

  private messages = new Map<string, FakeOutboundMessage>();
  private bySourceAndChannel = new Map<string, string>();
  private counter = 0;

  async triggerHandover(input: {
    conversationId: string;
    reason: string;
    sourceMessageId: string | null;
    sourceType: "text" | "voice" | "system";
  }) {
    this.handoverCalls.push(input);
    return {
      id: input.conversationId,
      state: "handover_requested" as ConversationState,
      handoverReason: input.reason,
      isNewEvent: true,
    };
  }

  async reserveAiOutboundMessage(sourceMessageId: string, channelType: MessageChannelType) {
    const key = `${sourceMessageId}:${channelType}`;
    const existingId = this.bySourceAndChannel.get(key);
    if (existingId) {
      const existing = this.messages.get(existingId)!;
      return {
        id: existingId,
        claimed: false,
        outboundStatus: existing.outboundStatus,
        providerMessageId: existing.providerMessageId,
      };
    }
    this.counter += 1;
    const id = `msg-out-${this.counter}`;
    this.bySourceAndChannel.set(key, id);
    this.messages.set(id, { outboundStatus: "sending", providerMessageId: null });
    return {
      id,
      claimed: true,
      outboundStatus: "sending" as OutboundDeliveryStatus,
      providerMessageId: null,
    };
  }

  async finalizeAiOutboundMessage(
    messageId: string,
    status: OutboundDeliveryStatus,
    providerMessageId: string | null,
  ) {
    const msg = this.messages.get(messageId);
    if (!msg) throw new Error("message_not_found");
    msg.outboundStatus = status;
    msg.providerMessageId = providerMessageId ?? msg.providerMessageId;
    return { id: messageId, outboundStatus: status };
  }

  getOutboundStatus(
    sourceMessageId: string,
    channelType: MessageChannelType,
  ): OutboundDeliveryStatus | undefined {
    const id = this.bySourceAndChannel.get(`${sourceMessageId}:${channelType}`);
    return id ? this.messages.get(id)?.outboundStatus : undefined;
  }

  async expireStaleOutboundSends() {
    return [];
  }
}

function makePayload(overrides: Partial<VoiceJobPayload> = {}): VoiceJobPayload {
  return {
    companyId: COMPANY_ID,
    conversationId: CONVERSATION_ID,
    messageId: "msg-1",
    waId: "919820000001",
    mediaId: "MEDIA1",
    mimeType: "audio/ogg",
    ...overrides,
  };
}

describe("processVoiceJob", () => {
  let repo: FakeVoiceConsumerRepository;
  let handoverRepo: FakeHandoverWorkerRepository;
  let whatsappProvider: MockWhatsAppProvider;
  let aiProvider: MockAiProvider;
  let sttProvider: MockSpeechToTextProvider;
  let ttsProvider: MockTextToSpeechProvider;
  let storageProvider: MockStorageProvider;
  let knowledgeRetriever: { retrieve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repo = new FakeVoiceConsumerRepository();
    handoverRepo = new FakeHandoverWorkerRepository();
    whatsappProvider = new MockWhatsAppProvider();
    aiProvider = new MockAiProvider();
    sttProvider = new MockSpeechToTextProvider();
    ttsProvider = new MockTextToSpeechProvider();
    storageProvider = new MockStorageProvider();
    knowledgeRetriever = { retrieve: vi.fn(async () => []) };
  });

  function makeDeps(entitlementSnapshot: EntitlementSnapshot): VoiceConsumerDeps {
    return {
      repo,
      handoverRepo,
      entitlementRepo: new FakeEntitlementRepository(entitlementSnapshot),
      knowledgeRetriever,
      aiProvider,
      whatsappProvider,
      sttProvider,
      ttsProvider,
      storageProvider,
      logger: silentLogger,
    };
  }

  it("transcribes, generates a reply, and sends both text and voice for a text_and_voice default", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());

    await processVoiceJob(deps, makePayload());

    expect(repo.recordedInboundAudio).toHaveLength(1);
    expect(repo.recordedTranscriptions).toHaveLength(1);
    expect(repo.recordedTranscriptions[0]).toMatchObject({ provider: sttProvider.providerName });
    expect(aiProvider.calls).toHaveLength(1);
    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentAudio).toHaveLength(1);
    expect(repo.recordedGeneratedAudio).toHaveLength(1);
    expect(handoverRepo.getOutboundStatus("msg-1", "text")).toBe("sent");
    expect(handoverRepo.getOutboundStatus("msg-1", "audio")).toBe("sent");
  });

  it("sends exactly one text and one voice reply per inbound message across a simulated redelivery, without re-synthesizing", async () => {
    const synthesizeSpy = vi.spyOn(ttsProvider, "synthesize");
    const deps = makeDeps(activeEntitlementSnapshot());

    await processVoiceJob(deps, makePayload());
    await processVoiceJob(deps, makePayload()); // redelivery of the same queue message

    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentAudio).toHaveLength(1);
    // TTS synthesis itself must not be re-attempted on redelivery, not just the send.
    expect(synthesizeSpy).toHaveBeenCalledTimes(1);
  });

  it("finalizes the voice reply as delivery_unknown (never throws) when TTS/upload/send fails ambiguously", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    deps.ttsProvider = {
      synthesize: async () => {
        throw new Error("network timeout");
      },
    };

    await expect(processVoiceJob(deps, makePayload())).resolves.toBeUndefined();

    // The text reply must have gone out exactly once -- a voice-reply failure
    // must never cause the whole job to retry and re-send it.
    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentAudio).toHaveLength(0);
    expect(handoverRepo.getOutboundStatus("msg-1", "audio")).toBe("delivery_unknown");
  });

  it("retrieves knowledge scoped to the company using the transcribed text", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    await processVoiceJob(deps, makePayload());
    expect(knowledgeRetriever.retrieve).toHaveBeenCalledWith(COMPANY_ID, expect.any(String));
  });

  it("never calls STT or WhatsApp send for a suspended company", async () => {
    const deps = makeDeps(activeEntitlementSnapshot({ companyStatus: "suspended" }));

    await processVoiceJob(deps, makePayload());

    expect(repo.recordedInboundAudio).toHaveLength(0);
    expect(whatsappProvider.sentText).toHaveLength(0);
    expect(whatsappProvider.sentAudio).toHaveLength(0);
  });

  describe("collaborative handover model (final plan section 5)", () => {
    it("keeps processing voice notes during human_active when ai_mode is active", async () => {
      repo.context = baseConversationContext({
        conversationState: "human_active",
        aiMode: "active",
      });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(repo.recordedInboundAudio).toHaveLength(1);
      expect(aiProvider.calls).toHaveLength(1);
    });

    it("suppresses voice processing whenever ai_mode is paused, regardless of conversation state", async () => {
      repo.context = baseConversationContext({
        conversationState: "human_active",
        aiMode: "paused",
      });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(repo.recordedInboundAudio).toHaveLength(0);
      expect(aiProvider.calls).toHaveLength(0);
    });
  });

  it("sends a text-only notice instead of going silent when voice is not entitled by the plan", async () => {
    const deps = makeDeps(
      activeEntitlementSnapshot({
        features: { voice_enabled: { isEnabled: false, numericLimit: null } },
      }),
    );

    await processVoiceJob(deps, makePayload());

    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentAudio).toHaveLength(0);
    // Blocked before transcription even happens -- this plan gets zero voice processing.
    expect(aiProvider.calls).toHaveLength(0);
  });

  it("sends a text-only notice and escalates when speech-to-text produces no transcript", async () => {
    sttProvider.fixedText = "";
    repo.context = baseConversationContext({
      voiceSettings: { ...baseConversationContext().voiceSettings, fallbackBehavior: "escalate" },
    });
    const deps = makeDeps(activeEntitlementSnapshot());

    await processVoiceJob(deps, makePayload());

    expect(handoverRepo.handoverCalls).toHaveLength(1);
    expect(handoverRepo.handoverCalls[0]).toMatchObject({
      reason: "speech_to_text_failed",
      sourceMessageId: "msg-1",
      sourceType: "voice",
    });
    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentAudio).toHaveLength(0);
    expect(aiProvider.calls).toHaveLength(0);
  });

  it("sends a text-only notice without escalating when fallback behavior is text_only_with_notice", async () => {
    sttProvider.fixedText = "";
    repo.context = baseConversationContext({
      voiceSettings: {
        ...baseConversationContext().voiceSettings,
        fallbackBehavior: "text_only_with_notice",
      },
    });
    const deps = makeDeps(activeEntitlementSnapshot());

    await processVoiceJob(deps, makePayload());

    expect(handoverRepo.handoverCalls).toHaveLength(0);
    expect(whatsappProvider.sentText).toHaveLength(1);
  });

  it("triggers a handover (sourceType: voice) when the AI response requires human attention", async () => {
    aiProvider.respond = () =>
      JSON.stringify({
        answer: "Let me get a team member to help with that.",
        language: "en",
        intent: "complex_request",
        confidence: 0.3,
        replyMode: "auto",
        leadUpdates: null,
        requiresHuman: true,
        handoverReason: "low_confidence",
        knowledgeSourceIds: [],
        internalNotes: null,
      });
    const deps = makeDeps(activeEntitlementSnapshot());

    await processVoiceJob(deps, makePayload());

    expect(handoverRepo.handoverCalls).toHaveLength(1);
    expect(handoverRepo.handoverCalls[0]).toMatchObject({
      reason: "low_confidence",
      sourceType: "voice",
    });
    // The customer-facing answer is still sent even when handing over.
    expect(whatsappProvider.sentText).toHaveLength(1);
  });

  it("applies lead updates extracted from the AI response", async () => {
    aiProvider.respond = () =>
      JSON.stringify({
        answer: "Great, I've noted your budget.",
        language: "en",
        intent: "website_enquiry",
        confidence: 0.9,
        replyMode: "auto",
        leadUpdates: { budget: "50000", service: "Website Development" },
        requiresHuman: false,
        handoverReason: null,
        knowledgeSourceIds: [],
        internalNotes: null,
      });
    const deps = makeDeps(activeEntitlementSnapshot());

    await processVoiceJob(deps, makePayload());

    expect(repo.appliedLeadUpdates).toEqual([{ budget: "50000", service: "Website Development" }]);
  });

  it("stores the inbound audio in the storage provider under the company's key prefix", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    await processVoiceJob(deps, makePayload());
    const keys = await storageProvider.list(`companies/${COMPANY_ID}/audio/inbound`);
    expect(keys).toHaveLength(1);
  });

  describe("Malayalam voice (regression: was misclassified as ai_response_validation_failed)", () => {
    const malayalamAnswer =
      "നിങ്ങളുടെ ചോദ്യത്തിന് നന്ദി. ഞങ്ങൾ വെബ്സൈറ്റ് ഡെവലപ്മെന്റ് സേവനങ്ങൾ വാഗ്ദാനം ചെയ്യുന്നു.";
    const mixedAnswer = "നന്ദി! We offer website development and AI automation services.";

    function malayalamResponse(overrides: Record<string, unknown> = {}) {
      return JSON.stringify({
        answer: malayalamAnswer,
        language: "ml",
        intent: "general_enquiry",
        confidence: 0.85,
        replyMode: "auto",
        leadUpdates: null,
        requiresHuman: false,
        handoverReason: null,
        knowledgeSourceIds: [],
        internalNotes: null,
        ...overrides,
      });
    }

    beforeEach(() => {
      sttProvider.fixedText = "എനിക്ക് വെബ്സൈറ്റ് വേണം";
      sttProvider.fixedDetectedLanguageCode = "ml";
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, enabledLanguages: ["en", "ml"] },
      });
    });

    it("accepts a valid Malayalam text response and sends it as-is", async () => {
      aiProvider.respond = () => malayalamResponse();
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentText[0]?.body).toBe(malayalamAnswer);
      expect(handoverRepo.handoverCalls).toHaveLength(0);
    });

    it("sends both a Malayalam text and a Malayalam voice reply", async () => {
      aiProvider.respond = () => malayalamResponse();
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentAudio).toHaveLength(1);
      expect(repo.recordedGeneratedAudio).toEqual([
        expect.objectContaining({ language: "ml", sourceText: malayalamAnswer }),
      ]);
    });

    it("accepts a Malayalam-English mixed-script response", async () => {
      aiProvider.respond = () => malayalamResponse({ answer: mixedAnswer });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentText[0]?.body).toBe(mixedAnswer);
    });

    it("repairs a malformed first response and still sends exactly one Malayalam reply (no duplicate)", async () => {
      let call = 0;
      aiProvider.respond = () => {
        call += 1;
        return call === 1 ? "{ not valid json" : malayalamResponse();
      };
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(aiProvider.calls).toHaveLength(2);
      expect(aiProvider.calls[1]?.repairInstruction).toContain("ml");
      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentText[0]?.body).toBe(malayalamAnswer);
      expect(handoverRepo.handoverCalls).toHaveLength(0);
    });

    it("uses the corrected, Malayalam safe-fallback text and escalates when both attempts fail", async () => {
      aiProvider.respond = () => "still not valid json after repair";
      repo.context = baseConversationContext({
        aiContext: {
          ...baseConversationContext().aiContext,
          enabledLanguages: ["en", "ml"],
          staticFallbackMessage:
            "Automated assistance is temporarily unavailable. Our team will respond as soon as possible.",
        },
      });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(handoverRepo.handoverCalls).toHaveLength(1);
      expect(handoverRepo.handoverCalls[0]).toMatchObject({
        reason: "ai_response_validation_failed",
        sourceType: "voice",
      });
      expect(whatsappProvider.sentText).toHaveLength(1);
      const sentFallback = whatsappProvider.sentText[0]?.body ?? "";
      expect(sentFallback).not.toContain("respond as soon as possible");
      expect(sentFallback).toMatch(/[ഀ-ൿ]/);
    });

    it("still triggers a handover for an explicit human request in Malayalam", async () => {
      aiProvider.respond = () =>
        malayalamResponse({
          requiresHuman: true,
          handoverReason: "customer_requested_human",
          answer: "ഒരു ജീവനക്കാരനെ ബന്ധിപ്പിക്കാം.",
        });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(handoverRepo.handoverCalls).toHaveLength(1);
      expect(handoverRepo.handoverCalls[0]).toMatchObject({
        reason: "customer_requested_human",
        sourceType: "voice",
      });
      expect(whatsappProvider.sentText).toHaveLength(1);
    });

    it("does not trigger a handover for an ordinary Malayalam enquiry", async () => {
      aiProvider.respond = () => malayalamResponse();
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(handoverRepo.handoverCalls).toHaveLength(0);
    });
  });
});
