import { MockAiProvider, type AiUsageRecorderInput } from "@dravonix/ai";
import type { EntitlementRepository, EntitlementSnapshot } from "@dravonix/billing";
import { resolveConversationTemporalContext, type ConversationState } from "@dravonix/core";
import type { UsageEventInsert } from "@dravonix/database";
import type {
  HandoverWorkerRepository,
  MessageChannelType,
  OutboundDeliveryStatus,
} from "@dravonix/handover";
import { createLogger } from "@dravonix/observability";
import {
  ElevenLabsProviderError,
  MockSpeechToTextProvider,
  MockTextToSpeechProvider,
  type SpeechToTextProvider,
} from "@dravonix/speech";
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
    temporal: resolveConversationTemporalContext({
      companyTimezone: "Asia/Kolkata",
      customerTimezone: null,
      now: new Date("2026-01-15T09:00:00.000Z"),
    }),
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

/**
 * In-memory double that actually implements the select-or-create contract
 * documented on VoiceConsumerRepository (voice pipeline reliability phase),
 * keyed by messageId -- so tests exercise the real retry-safety behavior
 * (reuse existing media/transcript, skip re-downloading/re-transcribing),
 * not just record every call unconditionally like the pre-fix version of
 * this fake did.
 */
class FakeVoiceConsumerRepository implements VoiceConsumerRepository {
  context: VoiceConversationContext = baseConversationContext();
  recordedInboundAudio: unknown[] = [];
  recordedTranscriptions: unknown[] = [];
  recordedGeneratedAudio: unknown[] = [];
  appliedLeadUpdates: unknown[] = [];
  recordedJobFailures: Array<{
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
  }> = [];

  // Composite-keyed by companyId+messageId -- mirrors
  // SupabaseVoiceConsumerRepository's actual `.eq("company_id", ...).eq("message_id", ...)`
  // filter, which is the real (application-level, since this repository
  // uses the RLS-bypassing service-role client) tenant-isolation boundary
  // for these lookups. Keying only by messageId here would silently pass
  // over that boundary and make this fake unfaithful to production.
  private mediaByKey = new Map<string, { mediaFileId: string; mimeType: string | null }>();
  private transcriptionByMessageId = new Map<
    string,
    { rawText: string; detectedLanguage: string | null; languageConfidence: number | null }
  >();
  private mediaCounter = 0;

  private mediaKey(companyId: string, messageId: string): string {
    return `${companyId}:${messageId}`;
  }

  async loadConversationContext(_conversationId: string): Promise<VoiceConversationContext> {
    return this.context;
  }

  async findExistingTranscription(input: { messageId: string }) {
    // Not company-scoped in the real repository either -- message_id is a
    // globally unique UUID FK-bound to exactly one company's messages row,
    // so a cross-company collision here is structurally impossible without
    // violating that FK (see repository.ts's comment).
    return this.transcriptionByMessageId.get(input.messageId) ?? null;
  }

  async findExistingInboundAudio(input: { companyId: string; messageId: string }) {
    return this.mediaByKey.get(this.mediaKey(input.companyId, input.messageId)) ?? null;
  }

  async recordInboundAudio(input: {
    companyId: string;
    messageId: string;
    mimeType: string | null;
  }): Promise<{ mediaFileId: string }> {
    this.recordedInboundAudio.push(input);
    this.mediaCounter += 1;
    const mediaFileId = `media-file-${this.mediaCounter}`;
    this.mediaByKey.set(this.mediaKey(input.companyId, input.messageId), {
      mediaFileId,
      mimeType: input.mimeType,
    });
    return { mediaFileId };
  }

  async recordTranscription(input: {
    messageId: string;
    rawText: string;
    detectedLanguage: string | null;
    languageConfidence: number | null;
  }): Promise<void> {
    this.recordedTranscriptions.push(input);
    this.transcriptionByMessageId.set(input.messageId, {
      rawText: input.rawText,
      detectedLanguage: input.detectedLanguage,
      languageConfidence: input.languageConfidence,
    });
  }

  async recordGeneratedAudioMetadata(input: unknown): Promise<void> {
    this.recordedGeneratedAudio.push(input);
  }

  async applyLeadUpdates(input: { leadUpdates: unknown }): Promise<void> {
    this.appliedLeadUpdates.push(input.leadUpdates);
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
    this.recordedJobFailures.push(input);
  }

  /** Deduped by idempotency_key, mirroring usage_events' real unique constraint + ON CONFLICT DO NOTHING behavior -- so a test can call the job twice and assert no double-counting the same way the real database would enforce it. */
  recordedUsageEvents: UsageEventInsert[] = [];
  private seenIdempotencyKeys = new Set<string>();

  async recordAiUsage(input: AiUsageRecorderInput): Promise<void> {
    // Mirrors SupabaseVoiceConsumerRepository.recordAiUsage's keying -- see
    // AiUsageRecorderInput.callId's doc comment.
    const keyPrefix = `${input.messageId}:${input.callId}`;
    await this.recordUsageEvents([
      {
        companyId: input.companyId,
        conversationId: input.conversationId,
        metric: "claude_requests",
        quantity: input.requestCount,
        idempotencyKey: `${keyPrefix}:claude_requests`,
      },
      {
        companyId: input.companyId,
        conversationId: input.conversationId,
        metric: "claude_input_tokens",
        quantity: input.usage.inputTokens,
        idempotencyKey: `${keyPrefix}:claude_input_tokens`,
      },
      {
        companyId: input.companyId,
        conversationId: input.conversationId,
        metric: "claude_output_tokens",
        quantity: input.usage.outputTokens,
        idempotencyKey: `${keyPrefix}:claude_output_tokens`,
      },
      {
        companyId: input.companyId,
        conversationId: input.conversationId,
        metric: "claude_cached_input_tokens",
        quantity: input.usage.cachedInputTokens,
        idempotencyKey: `${keyPrefix}:claude_cached_input_tokens`,
      },
    ]);
  }

  async recordUsageEvents(events: UsageEventInsert[]): Promise<void> {
    for (const event of events) {
      if (this.seenIdempotencyKeys.has(event.idempotencyKey)) continue;
      this.seenIdempotencyKeys.add(event.idempotencyKey);
      this.recordedUsageEvents.push(event);
    }
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

  /**
   * Meta/WhatsApp Batch 2: defaults to "now" (a wide-open service window)
   * and no fallback template, so every pre-existing test in this file that
   * never overrides serviceWindowState keeps behaving exactly as before
   * this batch.
   */
  serviceWindowState: { lastCustomerMessageAt: string | null; fallbackTemplate: null } = {
    lastCustomerMessageAt: new Date().toISOString(),
    fallbackTemplate: null,
  };

  private messages = new Map<string, FakeOutboundMessage>();
  private bySourceAndChannel = new Map<string, string>();
  private counter = 0;

  async getServiceWindowState(_sourceMessageId: string) {
    return this.serviceWindowState;
  }

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
    jobId: "job-1",
    correlationId: "corr-1",
    attempt: 1,
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

  function makeDeps(
    entitlementSnapshot: EntitlementSnapshot,
    voiceReplyMode: VoiceConsumerDeps["voiceReplyMode"] = "text_and_audio",
  ): VoiceConsumerDeps {
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
      voiceReplyMode,
      queueName: "dravonix-voice-queue-staging",
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

  it("passes the conversation's resolved temporal context through to the AI generation input, identically to the text pipeline (Global Timezone + Daypart Awareness)", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    repo.context = baseConversationContext({
      temporal: resolveConversationTemporalContext({
        companyTimezone: "Asia/Dubai",
        customerTimezone: "Europe/London",
        now: new Date("2026-06-10T10:00:00.000Z"),
      }),
    });

    await processVoiceJob(deps, makePayload());

    expect(aiProvider.calls).toHaveLength(1);
    const temporal = aiProvider.calls[0]?.input.temporal;
    expect(temporal?.company.timezone).toBe("Asia/Dubai");
    expect(temporal?.customer.timezone).toBe("Europe/London");
    expect(temporal?.customer.timezoneKnown).toBe(true);
  });

  it("Meta/WhatsApp Batch 2: sends the voice reply normally when inside the service window (item 11)", async () => {
    const synthesizeSpy = vi.spyOn(ttsProvider, "synthesize");
    const deps = makeDeps(activeEntitlementSnapshot());
    handoverRepo.serviceWindowState = {
      lastCustomerMessageAt: new Date().toISOString(),
      fallbackTemplate: null,
    };

    await processVoiceJob(deps, makePayload());

    expect(synthesizeSpy).toHaveBeenCalledTimes(1);
    expect(whatsappProvider.sentAudio).toHaveLength(1);
    expect(whatsappProvider.sentTemplate).toHaveLength(0);
  });

  it("Meta/WhatsApp Batch 2: outside the service window, never invokes TTS at all and sends the template fallback instead (items 12, 13)", async () => {
    const synthesizeSpy = vi.spyOn(ttsProvider, "synthesize");
    const deps = makeDeps(activeEntitlementSnapshot());
    handoverRepo.serviceWindowState = {
      lastCustomerMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      fallbackTemplate: { id: "tpl-1", name: "reengagement_v1", language: "en" },
    };

    await processVoiceJob(deps, makePayload());

    expect(synthesizeSpy).not.toHaveBeenCalled();
    expect(whatsappProvider.sentText).toHaveLength(0);
    expect(whatsappProvider.sentAudio).toHaveLength(0);
    // text_and_voice mode wants both a text and an audio reply for this one
    // inbound message -- outside the window, both collapse into exactly one
    // shared template send (see sendServiceWindowFallback's dedup).
    expect(whatsappProvider.sentTemplate).toHaveLength(1);
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

  describe("retry safety: media_files/transcriptions idempotency (voice pipeline reliability phases 3-5)", () => {
    it("CASE A: a duplicate queue delivery before any processing produces a single logical media record", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());
      await processVoiceJob(deps, makePayload());

      expect(repo.recordedInboundAudio).toHaveLength(1);
      expect(repo.recordedTranscriptions).toHaveLength(1);
    });

    it("CASE B/C: a retry after the media row (and stored object) already exist reuses the same media record and never re-downloads from WhatsApp", async () => {
      const getMediaMetadataSpy = vi.spyOn(whatsappProvider, "getMediaMetadata");
      const downloadMediaSpy = vi.spyOn(whatsappProvider, "downloadMedia");
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());
      expect(getMediaMetadataSpy).toHaveBeenCalledTimes(1);
      expect(downloadMediaSpy).toHaveBeenCalledTimes(1);

      await processVoiceJob(deps, makePayload()); // simulated retry

      // No second WhatsApp media fetch -- the retry found the media_files
      // row (and its stored R2 object) already present and reused both.
      expect(getMediaMetadataSpy).toHaveBeenCalledTimes(1);
      expect(downloadMediaSpy).toHaveBeenCalledTimes(1);
      expect(repo.recordedInboundAudio).toHaveLength(1);
    });

    it("CASE D: a retry after transcription already succeeded/persisted does not call the STT provider again", async () => {
      const transcribeSpy = vi.spyOn(sttProvider, "transcribe");
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());
      expect(transcribeSpy).toHaveBeenCalledTimes(1);

      await processVoiceJob(deps, makePayload()); // simulated retry

      expect(transcribeSpy).toHaveBeenCalledTimes(1);
      expect(repo.recordedTranscriptions).toHaveLength(1);
    });

    it("reuses the persisted transcript's own detected language/confidence on a retry, not the fresh-request defaults", async () => {
      sttProvider.fixedDetectedLanguageCode = "ml";
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());
      const firstDetected = repo.recordedTranscriptions[0] as { detectedLanguage: string | null };
      expect(firstDetected.detectedLanguage).toBe("ml");

      // A second delivery must reuse the already-persisted transcript
      // (including its detected language) rather than calling STT again --
      // asserted indirectly via CASE D's transcribeSpy above and directly
      // here via the AI call actually seeing the reused language.
      aiProvider.calls.length = 0;
      await processVoiceJob(deps, makePayload());
      expect(aiProvider.calls[0]?.input.currentDetectedLanguage).toBe("ml");
    });
  });

  describe("ElevenLabs failure classification and safe recording (voice pipeline reliability phases 5-8)", () => {
    function throwingSttProvider(error: unknown): SpeechToTextProvider {
      return {
        providerName: "elevenlabs",
        transcribe: async () => {
          throw error;
        },
      };
    }

    it("CASE E: a retryable ElevenLabs failure (5xx/timeout) is rethrown so the existing queue retry mechanism handles it, and records no job failure", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      deps.sttProvider = throwingSttProvider(
        new ElevenLabsProviderError(
          "ElevenLabs speech-to-text request failed with status 503",
          503,
          "server_error",
          true,
        ),
      );

      await expect(processVoiceJob(deps, makePayload())).rejects.toThrow(ElevenLabsProviderError);
      expect(repo.recordedJobFailures).toHaveLength(0);
      expect(repo.recordedInboundAudio).toHaveLength(1); // media was already durably recorded before the STT call
    });

    it("CASE F: a 429 rate-limit failure is classified retryable and rethrown, not swallowed", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      deps.sttProvider = throwingSttProvider(
        new ElevenLabsProviderError(
          "ElevenLabs speech-to-text request failed with status 429",
          429,
          "rate_limited",
          true,
        ),
      );

      await expect(processVoiceJob(deps, makePayload())).rejects.toThrow(ElevenLabsProviderError);
      expect(repo.recordedJobFailures).toHaveLength(0);
    });

    it("CASE G/I: a non-retryable configuration/authentication failure is recorded as exactly one durable job_failure and the job stops without throwing (no wasted retries)", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      deps.sttProvider = throwingSttProvider(
        new ElevenLabsProviderError(
          "ElevenLabs speech-to-text request failed with status 401 (category: authentication_error)",
          401,
          "authentication_error",
          false,
        ),
      );

      await expect(processVoiceJob(deps, makePayload())).resolves.toBeUndefined();

      expect(repo.recordedJobFailures).toHaveLength(1);
      expect(repo.recordedJobFailures[0]).toMatchObject({
        stage: "stt_transcription",
        category: "authentication_error",
        retryable: false,
        messageId: "msg-1",
        jobId: "job-1",
        queueName: "dravonix-voice-queue-staging",
      });
      // No customer-visible reply is fabricated for a config failure --
      // this is a platform-side problem, not something re-sending fixes.
      expect(whatsappProvider.sentText).toHaveLength(0);
      expect(aiProvider.calls).toHaveLength(0);
    });

    it("CASE H: the sanitized job_failure summary never contains raw provider response detail", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      const sensitiveDetail = "sk_live_leaked_key_should_never_appear_1234567890";
      // Simulates what the real elevenLabsSttProvider would throw -- already
      // sanitized at the provider boundary (see elevenLabsError.ts), so this
      // is really asserting the whole pipeline never reintroduces a leak
      // downstream even if a future provider change forgot to sanitize.
      deps.sttProvider = throwingSttProvider(
        new ElevenLabsProviderError(
          "ElevenLabs speech-to-text request failed with status 401 (category: authentication_error)",
          401,
          "authentication_error",
          false,
        ),
      );

      await processVoiceJob(deps, makePayload());

      const failure = repo.recordedJobFailures[0];
      expect(failure).toBeDefined();
      expect(failure!.errorSummary).not.toContain("sk_");
      expect(failure!.errorSummary).not.toContain(sensitiveDetail);
    });

    it("CASE I: a second retry of the same job after a recorded terminal failure does not record a duplicate failure or re-attempt STT once the underlying config is fixed", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      deps.sttProvider = throwingSttProvider(
        new ElevenLabsProviderError("auth failed", 401, "authentication_error", false),
      );

      await processVoiceJob(deps, makePayload());
      expect(repo.recordedJobFailures).toHaveLength(1);

      // Operator fixes the credential; a fresh retry of the same logical
      // job (no transcription was ever persisted, since the failure was
      // before recordTranscription) proceeds normally and succeeds.
      deps.sttProvider = sttProvider;
      await processVoiceJob(deps, makePayload());

      expect(repo.recordedTranscriptions).toHaveLength(1);
      expect(whatsappProvider.sentText).toHaveLength(1);
    });
  });

  describe("tenant isolation (PHASE 16)", () => {
    it("scopes the media_files select-or-create lookup by companyId, not messageId alone", async () => {
      // message_id is a globally unique UUID FK-bound to exactly one
      // company's `messages` row (see repository.ts), so a real
      // cross-company collision on messageId alone can't occur without
      // violating that FK. The company_id filter in
      // findExistingInboundAudio is still the actual (application-level,
      // since this repository uses the RLS-bypassing service-role client)
      // isolation boundary -- this test locks in that every lookup passes
      // the caller's own companyId, not a hardcoded/wrong one.
      const COMPANY_B = "bbbbbbbb-0000-0000-0000-000000000002";
      const findSpy = vi.spyOn(repo, "findExistingInboundAudio");
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload({ messageId: "msg-company-a" }));

      repo.context = baseConversationContext({ companyId: COMPANY_B });
      await processVoiceJob(
        deps,
        makePayload({ companyId: COMPANY_B, conversationId: "conv-b", messageId: "msg-company-b" }),
      );

      expect(findSpy).toHaveBeenNthCalledWith(1, {
        companyId: COMPANY_ID,
        messageId: "msg-company-a",
      });
      expect(findSpy).toHaveBeenNthCalledWith(2, {
        companyId: COMPANY_B,
        messageId: "msg-company-b",
      });
      expect(repo.recordedInboundAudio).toHaveLength(2);
      expect(repo.recordedInboundAudio[0]).toMatchObject({ companyId: COMPANY_ID });
      expect(repo.recordedInboundAudio[1]).toMatchObject({ companyId: COMPANY_B });
    });

    it("never cross-resolves two companies' job_failures under an authentication failure", async () => {
      const COMPANY_B = "bbbbbbbb-0000-0000-0000-000000000002";
      const failingStt: SpeechToTextProvider = {
        providerName: "elevenlabs",
        transcribe: async () => {
          throw new ElevenLabsProviderError("auth failed", 401, "authentication_error", false);
        },
      };
      const deps = makeDeps(activeEntitlementSnapshot());
      deps.sttProvider = failingStt;

      await processVoiceJob(deps, makePayload({ messageId: "msg-company-a" }));

      repo.context = baseConversationContext({ companyId: COMPANY_B });
      await processVoiceJob(
        deps,
        makePayload({ companyId: COMPANY_B, conversationId: "conv-b", messageId: "msg-company-b" }),
      );

      expect(repo.recordedJobFailures).toHaveLength(2);
      expect(repo.recordedJobFailures[0]).toMatchObject({
        companyId: COMPANY_ID,
        messageId: "msg-company-a",
      });
      expect(repo.recordedJobFailures[1]).toMatchObject({
        companyId: COMPANY_B,
        messageId: "msg-company-b",
      });
    });
  });

  it("finalizes the voice reply as delivery_unknown (never throws) when TTS/upload/send fails ambiguously", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    deps.ttsProvider = {
      providerName: "mock",
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

    it("still downloads, stores, and transcribes voice notes when ai_mode is paused, but suppresses the AI reply", async () => {
      // Staging incident (2026-08-05): the ai_mode gate used to sit before
      // media download/storage/transcription, so a paused conversation lost
      // the customer's voice note entirely -- the dashboard showed an empty
      // audio card with no transcript. ai_mode must only gate the AI-reply
      // half of this pipeline (final plan section 5), never ingestion.
      repo.context = baseConversationContext({
        conversationState: "human_active",
        aiMode: "paused",
      });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(repo.recordedInboundAudio).toHaveLength(1);
      expect(repo.recordedTranscriptions).toHaveLength(1);
      expect(aiProvider.calls).toHaveLength(0);
      expect(whatsappProvider.sentText).toHaveLength(0);
      expect(whatsappProvider.sentAudio).toHaveLength(0);
      expect(handoverRepo.handoverCalls).toHaveLength(0);
    });

    it("does not re-run media download, transcription, or generate an AI reply on a redelivery received while ai_mode is paused", async () => {
      // Voice pipeline reliability phase: payload.messageId-keyed
      // select-or-create dedup applies regardless of ai_mode/conversation
      // state -- a redelivered job reuses the already-persisted media and
      // transcript exactly as it would for an active conversation.
      repo.context = baseConversationContext({
        conversationState: "human_active",
        aiMode: "paused",
      });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());
      await processVoiceJob(deps, makePayload()); // redelivery of the same queue message

      expect(repo.recordedInboundAudio).toHaveLength(1);
      expect(repo.recordedTranscriptions).toHaveLength(1);
      expect(aiProvider.calls).toHaveLength(0);
      expect(whatsappProvider.sentText).toHaveLength(0);
      expect(whatsappProvider.sentAudio).toHaveLength(0);
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

    it("does not trigger a handover for an ordinary Malayalam enquiry about branding/website/pricing/company info", async () => {
      aiProvider.respond = () =>
        malayalamResponse({
          answer:
            "ഞങ്ങൾ ബ്രാൻഡിംഗ്, വെബ്സൈറ്റ് ഡെവലപ്മെന്റ് സേവനങ്ങൾ വാഗ്ദാനം ചെയ്യുന്നു. വില 25,000 രൂപ മുതൽ ആരംഭിക്കുന്നു.",
          knowledgeSourceIds: ["pricing-source-1"],
        });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(handoverRepo.handoverCalls).toHaveLength(0);
      expect(whatsappProvider.sentText).toHaveLength(1);
    });

    it("follows the configured custom-quotation escalation rule in Malayalam, without hardcoding language", async () => {
      repo.context = baseConversationContext({
        aiContext: {
          ...baseConversationContext().aiContext,
          enabledLanguages: ["en", "ml"],
          handoverRules: ["customer requests a custom quotation"],
        },
      });
      aiProvider.respond = () =>
        malayalamResponse({
          requiresHuman: true,
          handoverReason: "custom_quotation_requested",
          answer: "ഒരു പ്രത്യേക ക്വട്ടേഷനായി ഞാൻ ഇത് ടീമിന് കൈമാറാം.",
        });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(handoverRepo.handoverCalls).toHaveLength(1);
      expect(handoverRepo.handoverCalls[0]).toMatchObject({
        reason: "custom_quotation_requested",
        sourceType: "voice",
      });
    });

    it("never sends a duplicate Malayalam audio reply across a simulated redelivery", async () => {
      const synthesizeSpy = vi.spyOn(ttsProvider, "synthesize");
      aiProvider.respond = () => malayalamResponse();
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());
      await processVoiceJob(deps, makePayload()); // redelivery of the same queue message

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentAudio).toHaveLength(1);
      expect(synthesizeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Malayalam natural-speech TTS preparation", () => {
    beforeEach(() => {
      sttProvider.fixedText = "എനിക്ക് വെബ്സൈറ്റ് വേണം";
      sttProvider.fixedDetectedLanguageCode = "ml";
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, enabledLanguages: ["en", "ml"] },
      });
    });

    function malayalamResponseWith(answer: string) {
      return JSON.stringify({
        answer,
        language: "ml",
        intent: "general_enquiry",
        confidence: 0.85,
        replyMode: "auto",
        leadUpdates: null,
        requiresHuman: false,
        handoverReason: null,
        knowledgeSourceIds: [],
        internalNotes: null,
      });
    }

    it("synthesizes with languageCode ml for a Malayalam reply, while the WhatsApp text stays unchanged", async () => {
      const displayText = "നന്ദി, ഞങ്ങൾ സഹായിക്കാം.";
      aiProvider.respond = () => malayalamResponseWith(displayText);
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText[0]?.body).toBe(displayText);
      expect(ttsProvider.calls).toHaveLength(1);
      expect(ttsProvider.calls[0]?.languageCode).toBe("ml");
    });

    it("shortens a Markdown-formatted list for TTS without changing the displayed WhatsApp text", async () => {
      const displayText =
        "ഞങ്ങളുടെ സേവനങ്ങൾ ഇവയാണ്:\n1. Website Design ചെയ്യും\n2. Branding സഹായിക്കും\n3. Social Media കൈകാര്യം ചെയ്യും";
      aiProvider.respond = () => malayalamResponseWith(displayText);
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText[0]?.body).toBe(displayText);
      expect(ttsProvider.calls[0]?.text).toBe(
        "ഞങ്ങളുടെ സേവനങ്ങൾ ഇവയാണ്. Website Design ചെയ്യും. Branding സഹായിക്കും. Social Media കൈകാര്യം ചെയ്യും",
      );
      expect(ttsProvider.calls[0]?.text).not.toMatch(/[0-9]\.|[•●▪]/);
    });

    it("converts currency and numbers into spoken Malayalam for TTS, leaving the display text untouched", async () => {
      const displayText = "വെബ്സൈറ്റ് പാക്കേജ് ₹30,000 ആണ്, 10 pages വരെ ഉൾപ്പെടും.";
      aiProvider.respond = () => malayalamResponseWith(displayText);
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText[0]?.body).toBe(displayText);
      expect(ttsProvider.calls[0]?.text).toContain("മുപ്പതിനായിരം രൂപ");
      expect(ttsProvider.calls[0]?.text).toContain("പത്ത് pages");
    });

    it("selects the Malayalam TTS voice (languageCode ml) for a Malayalam-dominant mixed reply", async () => {
      const displayText =
        "നിങ്ങളുടെ requirement മനസ്സിലായി, ഞങ്ങൾ website, branding എന്നിവ ചെയ്യുന്നു, budget range ഒന്ന് പറയാമോ?";
      aiProvider.respond = () => malayalamResponseWith(displayText);
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(ttsProvider.calls[0]?.languageCode).toBe("ml");
    });
  });

  describe("English voice behaviour is unchanged by the Malayalam fix", () => {
    it("still transcribes, replies, and sends text and voice for an English voice note", async () => {
      sttProvider.fixedText = "What services do you offer?";
      sttProvider.fixedDetectedLanguageCode = "en";
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentAudio).toHaveLength(1);
      expect(handoverRepo.handoverCalls).toHaveLength(0);
    });

    it("synthesizes with languageCode en and the unmodified display text for an English reply", async () => {
      sttProvider.fixedText = "What services do you offer?";
      sttProvider.fixedDetectedLanguageCode = "en";
      aiProvider.respond = () =>
        JSON.stringify({
          answer: "We offer website design and branding packages.",
          language: "en",
          intent: "general_enquiry",
          confidence: 0.9,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false,
          handoverReason: null,
          knowledgeSourceIds: [],
          internalNotes: null,
        });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(ttsProvider.calls[0]?.languageCode).toBe("en");
      expect(ttsProvider.calls[0]?.text).toBe("We offer website design and branding packages.");
    });

    it("still escalates for an explicit English human request", async () => {
      sttProvider.fixedText = "I want to speak to a human.";
      sttProvider.fixedDetectedLanguageCode = "en";
      aiProvider.respond = () =>
        JSON.stringify({
          answer: "Sure, connecting you with our team.",
          language: "en",
          intent: "human_request",
          confidence: 0.9,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: true,
          handoverReason: "customer_requested_human",
          knowledgeSourceIds: [],
          internalNotes: null,
        });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(handoverRepo.handoverCalls).toHaveLength(1);
      expect(handoverRepo.handoverCalls[0]).toMatchObject({ reason: "customer_requested_human" });
    });
  });

  describe("VOICE_REPLY_MODE", () => {
    function malayalamResponse(answer: string) {
      return () =>
        JSON.stringify({
          answer,
          language: "ml",
          intent: "general_enquiry",
          confidence: 0.85,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false,
          handoverReason: null,
          knowledgeSourceIds: [],
          internalNotes: null,
        });
    }

    beforeEach(() => {
      repo.context = baseConversationContext({
        aiContext: {
          ...baseConversationContext().aiContext,
          enabledLanguages: ["en", "ml", "hi", "ar"],
        },
      });
    });

    it("produces exactly one text reply for Malayalam voice input in text_only mode, without calling TTS, Meta audio-send, or R2 audio upload/reservation", async () => {
      aiProvider.respond = malayalamResponse("നന്ദി, ഞങ്ങൾ സഹായിക്കാം.");
      sttProvider.fixedDetectedLanguageCode = "ml";
      const deps = makeDeps(activeEntitlementSnapshot(), "text_only");

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentAudio).toHaveLength(0);
      expect(ttsProvider.calls).toHaveLength(0);
      expect(repo.recordedGeneratedAudio).toHaveLength(0);
      expect(handoverRepo.getOutboundStatus("msg-1", "audio")).toBeUndefined();
      const outboundAudioKeys = await storageProvider.list(
        `companies/${COMPANY_ID}/audio/outbound`,
      );
      expect(outboundAudioKeys).toHaveLength(0);
    });

    it("produces exactly one text reply for Malayalam-English mixed voice input in text_only mode", async () => {
      aiProvider.respond = malayalamResponse(
        "നിങ്ങളുടെ requirement ഒന്ന് പറഞ്ഞാൽ മതി, ഞങ്ങൾ website, branding എന്നിവ ചെയ്യുന്നു.",
      );
      sttProvider.fixedDetectedLanguageCode = "ml";
      const deps = makeDeps(activeEntitlementSnapshot(), "text_only");

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentAudio).toHaveLength(0);
      expect(ttsProvider.calls).toHaveLength(0);
    });

    it("produces exactly one text reply for English voice input in text_only mode", async () => {
      sttProvider.fixedDetectedLanguageCode = "en";
      const deps = makeDeps(activeEntitlementSnapshot(), "text_only");

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentAudio).toHaveLength(0);
      expect(ttsProvider.calls).toHaveLength(0);
    });

    it("produces exactly one text reply for Hindi and Arabic voice input in text_only mode", async () => {
      for (const languageCode of ["hi", "ar"]) {
        whatsappProvider = new MockWhatsAppProvider();
        ttsProvider = new MockTextToSpeechProvider();
        sttProvider.fixedDetectedLanguageCode = languageCode;
        const deps = makeDeps(activeEntitlementSnapshot(), "text_only");

        await processVoiceJob(deps, makePayload({ messageId: `msg-${languageCode}` }));

        expect(whatsappProvider.sentText).toHaveLength(1);
        expect(whatsappProvider.sentAudio).toHaveLength(0);
        expect(ttsProvider.calls).toHaveLength(0);
      }
    });

    it("still calls ElevenLabs speech-to-text (transcription) in text_only mode", async () => {
      const deps = makeDeps(activeEntitlementSnapshot(), "text_only");

      await processVoiceJob(deps, makePayload());

      expect(repo.recordedTranscriptions).toHaveLength(1);
      expect(repo.recordedTranscriptions[0]).toMatchObject({ provider: sttProvider.providerName });
    });

    it("does not send a duplicate text reply in text_only mode", async () => {
      const deps = makeDeps(activeEntitlementSnapshot(), "text_only");

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(handoverRepo.getOutboundStatus("msg-1", "text")).toBe("sent");
    });

    it("preserves the existing text-and-voice behaviour in text_and_audio mode", async () => {
      const deps = makeDeps(activeEntitlementSnapshot(), "text_and_audio");

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentAudio).toHaveLength(1);
      expect(ttsProvider.calls).toHaveLength(1);
      expect(repo.recordedGeneratedAudio).toHaveLength(1);
    });

    it("preserves collaborative handover behaviour: AI keeps replying when handover is requested and ai_mode stays active, even in text_only mode", async () => {
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
      repo.context = baseConversationContext({
        conversationState: "handover_requested",
        aiMode: "active",
      });
      const deps = makeDeps(activeEntitlementSnapshot(), "text_only");

      await processVoiceJob(deps, makePayload());

      expect(handoverRepo.handoverCalls).toHaveLength(1);
      // The customer-facing answer is still sent even while handover is pending.
      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentAudio).toHaveLength(0);
    });

    it("logs the sanitized voice-reply summary with audioReplySkipped and skipReason in text_only mode", async () => {
      const lines: string[] = [];
      const logger = createLogger(
        { environment: "test" },
        {
          write: (line: string) => {
            lines.push(line);
          },
        },
      );
      const deps = { ...makeDeps(activeEntitlementSnapshot(), "text_only"), logger };

      await processVoiceJob(deps, makePayload());

      const summaryLine = lines.find((line) => line.includes("Voice reply summary"));
      expect(summaryLine).toBeDefined();
      const summary = JSON.parse(summaryLine!);
      expect(summary).toMatchObject({
        inboundChannel: "voice",
        replyMode: "text_only",
        transcriptionCompleted: true,
        textReplySent: true,
        audioReplySkipped: true,
        skipReason: "reply_mode_text_only",
      });
      const serialized = lines.join("\n");
      expect(serialized).not.toContain("919820000001");
    });

    it("logs audioReplySkipped: false and omits skipReason in text_and_audio mode", async () => {
      const lines: string[] = [];
      const logger = createLogger(
        { environment: "test" },
        {
          write: (line: string) => {
            lines.push(line);
          },
        },
      );
      const deps = { ...makeDeps(activeEntitlementSnapshot(), "text_and_audio"), logger };

      await processVoiceJob(deps, makePayload());

      const summaryLine = lines.find((line) => line.includes("Voice reply summary"));
      const summary = JSON.parse(summaryLine!);
      expect(summary.audioReplySkipped).toBe(false);
      expect(summary.skipReason).toBeUndefined();
    });
  });

  describe("usage metering (P0 usage repair)", () => {
    it("records inbound message, AI, TTS-character, and both outbound message usages exactly once for a normal turn", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      const metrics = repo.recordedUsageEvents.map((e) => e.metric).sort();
      expect(metrics).toEqual(
        [
          "claude_cached_input_tokens",
          "claude_input_tokens",
          "claude_output_tokens",
          "claude_requests",
          "text_to_speech_characters",
          "whatsapp_inbound_messages",
          "whatsapp_outbound_messages",
          "whatsapp_outbound_messages", // text reply + audio reply are two distinct sends
        ].sort(),
      );
      // speech_to_text_seconds / generated_voice_seconds are deliberately
      // never recorded -- no trustworthy duration source exists (PHASE 6).
      expect(metrics).not.toContain("speech_to_text_seconds");
      expect(metrics).not.toContain("generated_voice_seconds");

      const ttsEvent = repo.recordedUsageEvents.find(
        (e) => e.metric === "text_to_speech_characters",
      );
      expect(ttsEvent?.quantity).toBeGreaterThan(0);

      const outboundEvents = repo.recordedUsageEvents.filter(
        (e) => e.metric === "whatsapp_outbound_messages",
      );
      expect(outboundEvents).toHaveLength(2);
      // Text and audio replies get distinct idempotency keys even though
      // both derive from the same inbound messageId.
      expect(new Set(outboundEvents.map((e) => e.idempotencyKey)).size).toBe(2);
    });

    it("CASE B: a repair attempt (2 real provider calls in one invocation) records claude_requests=2 with summed tokens", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      aiProvider.respond = (_input, repairInstruction) =>
        repairInstruction
          ? JSON.stringify({
              answer: "Repaired answer.",
              language: "en",
              intent: "general_enquiry",
              confidence: 0.8,
              replyMode: "auto",
              leadUpdates: null,
              requiresHuman: false,
              handoverReason: null,
              knowledgeSourceIds: [],
              internalNotes: null,
            })
          : "not valid json, forces a repair attempt";

      await processVoiceJob(deps, makePayload());

      expect(aiProvider.calls).toHaveLength(2); // first attempt + repair, same invocation
      const claudeRequests = repo.recordedUsageEvents.find((e) => e.metric === "claude_requests");
      expect(claudeRequests?.quantity).toBe(2);
      const inputTokens = repo.recordedUsageEvents.find((e) => e.metric === "claude_input_tokens");
      expect(inputTokens?.quantity).toBe(200); // MockAiProvider: 100 per call x 2 calls
      const outputTokens = repo.recordedUsageEvents.find(
        (e) => e.metric === "claude_output_tokens",
      );
      expect(outputTokens?.quantity).toBe(100); // MockAiProvider: 50 per call x 2 calls
    });

    it("CASE C: a simulated redelivery that genuinely re-invokes Claude retains TWO distinct sets of Claude provider-consumption usage (never collapsed as a duplicate), while WhatsApp/TTS metrics stay claim-guarded to one set", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());
      await processVoiceJob(deps, makePayload()); // redelivery of the same queue job -- Claude genuinely called again

      expect(aiProvider.calls).toHaveLength(2);

      const claudeRequestEvents = repo.recordedUsageEvents.filter(
        (e) => e.metric === "claude_requests",
      );
      expect(claudeRequestEvents).toHaveLength(2);
      expect(new Set(claudeRequestEvents.map((e) => e.idempotencyKey)).size).toBe(2);
      expect(claudeRequestEvents.reduce((sum, e) => sum + e.quantity, 0)).toBe(2);

      // P1 stabilization: the token metrics must ALSO be retained as two
      // distinct sets, not just claude_requests (same rationale as the
      // message-consumer counterpart test).
      for (const metric of [
        "claude_input_tokens",
        "claude_output_tokens",
        "claude_cached_input_tokens",
      ] as const) {
        const events = repo.recordedUsageEvents.filter((e) => e.metric === metric);
        expect(events, `expected two distinct ${metric} events`).toHaveLength(2);
        expect(
          new Set(events.map((e) => e.idempotencyKey)).size,
          `expected two distinct ${metric} idempotency keys`,
        ).toBe(2);
      }
      const inputTokenEvents = repo.recordedUsageEvents.filter(
        (e) => e.metric === "claude_input_tokens",
      );
      expect(inputTokenEvents.reduce((sum, e) => sum + e.quantity, 0)).toBe(200); // 100 per real call x 2 calls

      // TTS is structurally never genuinely re-invoked on redelivery -- the
      // reserve/claim guard in reserveAiOutboundMessage returns early before
      // synthesize() is called -- so its usage stays deduped to one set,
      // unlike Claude's.
      const ttsEvents = repo.recordedUsageEvents.filter(
        (e) => e.metric === "text_to_speech_characters",
      );
      const inboundEvents = repo.recordedUsageEvents.filter(
        (e) => e.metric === "whatsapp_inbound_messages",
      );
      const outboundEvents = repo.recordedUsageEvents.filter(
        (e) => e.metric === "whatsapp_outbound_messages",
      );
      expect(ttsEvents).toHaveLength(1);
      expect(inboundEvents).toHaveLength(1);
      expect(outboundEvents).toHaveLength(2); // text reply + audio reply, both claim-guarded
    });

    it("CASE D: re-persisting usage for the SAME provider call (same messageId + callId) remains idempotent", async () => {
      const usageInput: AiUsageRecorderInput = {
        companyId: COMPANY_ID,
        conversationId: CONVERSATION_ID,
        messageId: "msg-1",
        callId: "11111111-1111-1111-1111-111111111111",
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
        requestCount: 1,
        requestSucceeded: true,
      };

      await repo.recordAiUsage(usageInput);
      await repo.recordAiUsage(usageInput); // retry of persisting the SAME call's usage

      const claudeRequestEvents = repo.recordedUsageEvents.filter(
        (e) => e.metric === "claude_requests",
      );
      expect(claudeRequestEvents).toHaveLength(1);
      expect(claudeRequestEvents[0]?.quantity).toBe(1);
    });

    it("records the real TTS provider identity on generated_audio, never hardcoded", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());

      await processVoiceJob(deps, makePayload());

      expect(repo.recordedGeneratedAudio[0]).toMatchObject({ provider: ttsProvider.providerName });
    });

    it("records inbound message usage but no Claude/TTS usage when speech-to-text fails non-retryably before a transcript exists", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      sttProvider.transcribe = async () => {
        throw new ElevenLabsProviderError("speech-to-text", 400, "invalid_request", false);
      };

      await processVoiceJob(deps, makePayload());

      const metrics = repo.recordedUsageEvents.map((e) => e.metric);
      expect(metrics).toEqual(["whatsapp_inbound_messages"]);
    });

    it("records inbound message usage but no Claude/TTS usage when the AI provider fails before returning", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      aiProvider.respond = () => {
        throw new Error("simulated Anthropic authentication failure");
      };

      await expect(processVoiceJob(deps, makePayload())).rejects.toThrow();

      const metrics = repo.recordedUsageEvents.map((e) => e.metric);
      expect(metrics).toEqual(["whatsapp_inbound_messages"]);
    });

    it("does not record a TTS-character or audio outbound-message usage when TTS/upload/send fails ambiguously", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      deps.ttsProvider = {
        providerName: "mock",
        synthesize: async () => {
          throw new Error("network timeout");
        },
      };

      await processVoiceJob(deps, makePayload());

      const metrics = repo.recordedUsageEvents.map((e) => e.metric);
      expect(metrics).not.toContain("text_to_speech_characters");
      // Only one outbound message (the text reply) was actually sent.
      expect(metrics.filter((m) => m === "whatsapp_outbound_messages")).toHaveLength(1);
      // Claude usage is still metered -- the failure is downstream of generation.
      expect(metrics).toContain("claude_requests");
    });

    it("a usage-recording failure never blocks the customer-facing voice reply", async () => {
      const deps = makeDeps(activeEntitlementSnapshot());
      repo.recordUsageEvents = async () => {
        throw new Error("simulated usage_events write failure");
      };
      repo.recordAiUsage = async () => {
        throw new Error("simulated usage_events write failure");
      };

      await processVoiceJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
      expect(whatsappProvider.sentAudio).toHaveLength(1);
    });
  });
});
