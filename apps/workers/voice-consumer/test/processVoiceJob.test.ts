import { MockAiProvider } from "@dravonix/ai";
import type { EntitlementRepository, EntitlementSnapshot } from "@dravonix/billing";
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
  recordedOutboundText: Array<{ body: string; providerMessageId: string }> = [];
  recordedOutboundVoice: unknown[] = [];
  appliedLeadUpdates: unknown[] = [];
  handoverCalls: Array<{ conversationId: string; reason: string }> = [];

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

  async recordOutboundTextMessage(input: {
    body: string;
    providerMessageId: string;
  }): Promise<void> {
    this.recordedOutboundText.push(input);
  }

  async recordOutboundVoiceMessage(input: unknown): Promise<void> {
    this.recordedOutboundVoice.push(input);
  }

  async applyLeadUpdates(input: { leadUpdates: unknown }): Promise<void> {
    this.appliedLeadUpdates.push(input.leadUpdates);
  }

  async triggerHandover(input: { conversationId: string; reason: string }): Promise<void> {
    this.handoverCalls.push(input);
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
  let whatsappProvider: MockWhatsAppProvider;
  let aiProvider: MockAiProvider;
  let sttProvider: MockSpeechToTextProvider;
  let ttsProvider: MockTextToSpeechProvider;
  let storageProvider: MockStorageProvider;
  let knowledgeRetriever: { retrieve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repo = new FakeVoiceConsumerRepository();
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
    // Recorded provider must reflect the actual injected STT provider, not a
    // hardcoded vendor name that could drift out of sync with it.
    expect(repo.recordedTranscriptions[0]).toMatchObject({ provider: sttProvider.providerName });
    expect(aiProvider.calls).toHaveLength(1);
    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentAudio).toHaveLength(1);
    expect(repo.recordedOutboundText).toHaveLength(1);
    expect(repo.recordedOutboundVoice).toHaveLength(1);
  });

  it("degrades to the already-sent text reply without throwing when text-to-speech fails", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    deps.ttsProvider = {
      synthesize: async () => {
        throw new Error(
          "ElevenLabs text-to-speech request failed with status 402: payment_required",
        );
      },
    };

    await expect(processVoiceJob(deps, makePayload())).resolves.toBeUndefined();

    // The text reply must have gone out exactly once -- a TTS failure must
    // never cause the whole job to retry and re-send it.
    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentAudio).toHaveLength(0);
    expect(repo.recordedOutboundVoice).toHaveLength(0);
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

  it("never processes a voice note while a human agent has taken over the conversation", async () => {
    repo.context = baseConversationContext({ conversationState: "human_active" });
    const deps = makeDeps(activeEntitlementSnapshot());

    await processVoiceJob(deps, makePayload());

    expect(repo.recordedInboundAudio).toHaveLength(0);
    expect(aiProvider.calls).toHaveLength(0);
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

    expect(repo.handoverCalls).toHaveLength(1);
    expect(repo.handoverCalls[0]?.reason).toBe("speech_to_text_failed");
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

    expect(repo.handoverCalls).toHaveLength(0);
    expect(whatsappProvider.sentText).toHaveLength(1);
  });

  it("triggers a handover when the AI response requires human attention", async () => {
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

    expect(repo.handoverCalls).toHaveLength(1);
    expect(repo.handoverCalls[0]?.reason).toBe("low_confidence");
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
});
