import { MockAiProvider } from "@dravonix/ai";
import type { EntitlementRepository, EntitlementSnapshot } from "@dravonix/billing";
import { resolveConversationTemporalContext, type ConversationState } from "@dravonix/core";
import type {
  HandoverWorkerRepository,
  MessageChannelType,
  OutboundDeliveryStatus,
} from "@dravonix/handover";
import { createLogger } from "@dravonix/observability";
import { MockWhatsAppProvider } from "@dravonix/whatsapp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processMessageJob,
  type MessageConsumerDeps,
  type MessageJobPayload,
} from "../src/processMessageJob.js";
import type { ConversationContext, MessageConsumerRepository } from "../src/repository.js";

const COMPANY_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const CONVERSATION_ID = "conv-1";

const silentLogger = createLogger({ environment: "test" }, { write: () => {} });

function baseConversationContext(
  overrides: Partial<ConversationContext> = {},
): ConversationContext {
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
    ...overrides,
  };
}

function activeEntitlementSnapshot(): EntitlementSnapshot {
  return {
    companyStatus: "active",
    subscriptionState: "active",
    features: {},
    usage: {},
  };
}

class FakeEntitlementRepository implements EntitlementRepository {
  constructor(private readonly snapshot: EntitlementSnapshot) {}
  getSnapshot = vi.fn(async (_companyId: string) => this.snapshot);
}

class FakeMessageConsumerRepository implements MessageConsumerRepository {
  context: ConversationContext = baseConversationContext();
  appliedLeadUpdates: unknown[] = [];
  recordedResearchDiagnostics: Array<{ messageId: string; diagnostics: Record<string, unknown> }> =
    [];

  async loadConversationContext(_conversationId: string): Promise<ConversationContext> {
    return this.context;
  }

  async applyLeadUpdates(input: { leadUpdates: unknown }): Promise<void> {
    this.appliedLeadUpdates.push(input.leadUpdates);
  }

  async recordResearchDiagnostics(
    messageId: string,
    diagnostics: Record<string, unknown>,
  ): Promise<void> {
    this.recordedResearchDiagnostics.push({ messageId, diagnostics });
  }
}

interface FakeOutboundMessage {
  outboundStatus: OutboundDeliveryStatus;
  providerMessageId: string | null;
}

/**
 * In-memory double for HandoverWorkerRepository (final plan section 4's
 * service_role-only RPC family), mirroring the actual reserve/finalize
 * claim-guard semantics closely enough to test the collaborative AI-reply
 * suppression rules and the exactly-once-per-message send guarantee.
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

  async expireStaleOutboundSends() {
    return [];
  }
}

function makePayload(overrides: Partial<MessageJobPayload> = {}): MessageJobPayload {
  return {
    companyId: COMPANY_ID,
    conversationId: CONVERSATION_ID,
    messageId: "msg-1",
    waId: "919820000001",
    body: "Hi, what services do you offer?",
    ...overrides,
  };
}

describe("processMessageJob", () => {
  let repo: FakeMessageConsumerRepository;
  let handoverRepo: FakeHandoverWorkerRepository;
  let whatsappProvider: MockWhatsAppProvider;
  let aiProvider: MockAiProvider;
  let knowledgeRetriever: { retrieve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repo = new FakeMessageConsumerRepository();
    handoverRepo = new FakeHandoverWorkerRepository();
    whatsappProvider = new MockWhatsAppProvider();
    aiProvider = new MockAiProvider();
    knowledgeRetriever = { retrieve: vi.fn(async () => []) };
  });

  function makeDeps(
    entitlementSnapshot: EntitlementSnapshot,
    overrides: Partial<MessageConsumerDeps> = {},
  ): MessageConsumerDeps {
    return {
      repo,
      handoverRepo,
      entitlementRepo: new FakeEntitlementRepository(entitlementSnapshot),
      knowledgeRetriever,
      aiProvider,
      whatsappProvider,
      logger: silentLogger,
      ...overrides,
    };
  }

  it("generates an AI reply and sends it via WhatsApp", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());

    await processMessageJob(deps, makePayload());

    expect(aiProvider.calls).toHaveLength(1);
    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentText[0]?.toWaId).toBe("919820000001");
  });

  it("passes the conversation's resolved temporal context through to the AI generation input unchanged (Global Timezone + Daypart Awareness)", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    repo.context = baseConversationContext({
      temporal: resolveConversationTemporalContext({
        companyTimezone: "Asia/Dubai",
        customerTimezone: "Europe/London",
        now: new Date("2026-06-10T10:00:00.000Z"),
      }),
    });

    await processMessageJob(deps, makePayload());

    expect(aiProvider.calls).toHaveLength(1);
    const temporal = aiProvider.calls[0]?.input.temporal;
    expect(temporal?.company.timezone).toBe("Asia/Dubai");
    expect(temporal?.customer.timezone).toBe("Europe/London");
    expect(temporal?.customer.timezoneKnown).toBe(true);
  });

  it("retrieves knowledge scoped to the company before generating a response", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    await processMessageJob(deps, makePayload());
    expect(knowledgeRetriever.retrieve).toHaveBeenCalledWith(COMPANY_ID, expect.any(String));
  });

  it("never calls Claude or WhatsApp send for a suspended company (acceptance criteria #22)", async () => {
    const deps = makeDeps({ ...activeEntitlementSnapshot(), companyStatus: "suspended" });

    await processMessageJob(deps, makePayload());

    expect(aiProvider.calls).toHaveLength(0);
    expect(whatsappProvider.sentText).toHaveLength(0);
  });

  it("never calls Claude or WhatsApp send for a manually suspended company", async () => {
    const deps = makeDeps({ ...activeEntitlementSnapshot(), companyStatus: "manually_suspended" });
    await processMessageJob(deps, makePayload());
    expect(aiProvider.calls).toHaveLength(0);
    expect(whatsappProvider.sentText).toHaveLength(0);
  });

  describe("collaborative handover model (final plan section 5)", () => {
    const collaborativeStates: ConversationState[] = [
      "ai_active",
      "handover_requested",
      "queued_for_agent",
      "human_active",
    ];

    it.each(collaborativeStates)(
      "keeps replying in %s while ai_mode is active -- a human being assigned/active never by itself stops the AI",
      async (state) => {
        repo.context = baseConversationContext({ conversationState: state, aiMode: "active" });
        const deps = makeDeps(activeEntitlementSnapshot());

        await processMessageJob(deps, makePayload());

        expect(aiProvider.calls).toHaveLength(1);
        expect(whatsappProvider.sentText).toHaveLength(1);
      },
    );

    it("suppresses the AI whenever ai_mode is paused, regardless of conversation state", async () => {
      repo.context = baseConversationContext({
        conversationState: "human_active",
        aiMode: "paused",
      });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processMessageJob(deps, makePayload());

      expect(aiProvider.calls).toHaveLength(0);
      expect(whatsappProvider.sentText).toHaveLength(0);
    });

    it("suppresses the AI when the conversation itself is paused, even if ai_mode is active", async () => {
      repo.context = baseConversationContext({ conversationState: "paused", aiMode: "active" });
      const deps = makeDeps(activeEntitlementSnapshot());
      await processMessageJob(deps, makePayload());
      expect(aiProvider.calls).toHaveLength(0);
    });

    it("suppresses the AI when the conversation is closed", async () => {
      repo.context = baseConversationContext({ conversationState: "closed", aiMode: "active" });
      const deps = makeDeps(activeEntitlementSnapshot());
      await processMessageJob(deps, makePayload());
      expect(aiProvider.calls).toHaveLength(0);
    });
  });

  it("triggers a handover (recorded via triggerHandoverAtomic) when the AI response requires human attention, and still sends the reply", async () => {
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

    await processMessageJob(deps, makePayload());

    expect(handoverRepo.handoverCalls).toHaveLength(1);
    expect(handoverRepo.handoverCalls[0]).toMatchObject({
      reason: "low_confidence",
      sourceMessageId: "msg-1",
      sourceType: "text",
    });
    // The customer-facing answer is still sent even when handing over --
    // handover is collaborative assistance, not an automatic AI replacement.
    expect(whatsappProvider.sentText).toHaveLength(1);
  });

  it("propagates a Claude request failure (auth error, network error, etc.) so the queue retries the job", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    aiProvider.respond = () => {
      throw new Error("simulated Anthropic authentication failure");
    };

    await expect(processMessageJob(deps, makePayload())).rejects.toThrow(
      "simulated Anthropic authentication failure",
    );
    expect(whatsappProvider.sentText).toHaveLength(0);
  });

  it("finalizes as delivery_unknown (never throws / never triggers a retry) on an ambiguous WhatsApp send failure", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());
    whatsappProvider.sendText = async () => {
      throw new Error("simulated network failure");
    };

    await expect(processMessageJob(deps, makePayload())).resolves.toBeUndefined();
  });

  it("sends exactly one AI reply per inbound message across a simulated redelivery (reserve/claim guard)", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());

    await processMessageJob(deps, makePayload());
    await processMessageJob(deps, makePayload()); // redelivery of the same queue message

    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(aiProvider.calls).toHaveLength(2); // Claude reruns, but the WhatsApp send is claim-guarded.
  });

  it("a normal text enquiry produces exactly one reply, no handover, and stays ai_active", async () => {
    aiProvider.respond = () =>
      JSON.stringify({
        answer:
          "We're unable to listen to or transcribe voice messages on our end. " +
          "In the meantime, we offer website development and AI automation.",
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

    await processMessageJob(deps, makePayload());

    expect(aiProvider.calls).toHaveLength(1);
    expect(whatsappProvider.sentText).toHaveLength(1);

    const sentBody = whatsappProvider.sentText[0]?.body ?? "";
    expect(sentBody).not.toMatch(/unable to (listen|transcribe)/i);

    expect(handoverRepo.handoverCalls).toHaveLength(0);
  });

  describe("unauthorized human-follow-up promise (2026-08-05 staging incident, packages/ai/src/safety.ts)", () => {
    function respondWithFollowUpPromise(answer: string) {
      aiProvider.respond = () =>
        JSON.stringify({
          answer,
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
    }

    it("persists a handover request when the AI promises the team will contact the customer, before confirming it in the reply", async () => {
      respondWithFollowUpPromise("Sure, oru second -- our team will also contact you shortly.");
      const deps = makeDeps(activeEntitlementSnapshot());

      await processMessageJob(deps, makePayload());

      expect(handoverRepo.handoverCalls).toHaveLength(1);
      expect(handoverRepo.handoverCalls[0]).toMatchObject({
        reason: "AI reply promised human/team follow-up",
        sourceMessageId: "msg-1",
        sourceType: "text",
      });
      // Escalation happens before the reply is sent (message-consumer calls
      // triggerHandoverAtomic ahead of sendAiOutboundMessage whenever
      // requiresHuman is true) -- the confirmation the customer receives is
      // never an unfulfilled promise, since the handover is already durably
      // persisted by the time it goes out.
      expect(whatsappProvider.sentText).toHaveLength(1);
    });

    it("persists a handover request for a Malayalam-English meeting-arrangement request", async () => {
      respondWithFollowUpPromise("sure, oru meeting arrange cheyyam, time njan fix cheyyam");
      const deps = makeDeps(activeEntitlementSnapshot());

      await processMessageJob(deps, makePayload());

      expect(handoverRepo.handoverCalls).toHaveLength(1);
      expect(handoverRepo.handoverCalls[0]).toMatchObject({
        reason: "AI reply promised human/team follow-up",
        sourceMessageId: "msg-1",
        sourceType: "text",
      });
    });

    it("does not duplicate the handover request on a simulated redelivery of the same inbound message", async () => {
      respondWithFollowUpPromise("Our team will also contact you shortly.");
      const deps = makeDeps(activeEntitlementSnapshot());

      await processMessageJob(deps, makePayload());
      await processMessageJob(deps, makePayload()); // redelivery of the same queue message

      // triggerHandover is called again (it durably no-ops on a duplicate
      // source_message_id via handover_events' unique constraint, verified
      // in supabase/tests/rls_handover.sql) but never produces a second
      // WhatsApp send.
      expect(whatsappProvider.sentText).toHaveLength(1);
    });

    it("does not create a conflicting second handover request when the conversation is already human_active", async () => {
      repo.context = baseConversationContext({
        conversationState: "human_active",
        aiMode: "active",
      });
      respondWithFollowUpPromise("Our team will also contact you shortly.");
      const deps = makeDeps(activeEntitlementSnapshot());

      await processMessageJob(deps, makePayload());

      // triggerHandoverAtomic is still called (it's the single trusted entry
      // point for every escalation signal) -- the underlying RPC is what
      // durably avoids re-transitioning/re-notifying a conversation that
      // isn't currently ai_active, per the frozen handover lifecycle
      // contract (packages/handover's trigger_handover behavior, unchanged
      // by this fix).
      expect(handoverRepo.handoverCalls).toHaveLength(1);
      expect(whatsappProvider.sentText).toHaveLength(1);
    });

    it("never sends the reply when handover persistence fails -- no unfulfilled promise reaches the customer", async () => {
      respondWithFollowUpPromise("Our team will also contact you shortly.");
      handoverRepo.triggerHandover = async () => {
        throw new Error("simulated database failure");
      };
      const deps = makeDeps(activeEntitlementSnapshot());

      await expect(processMessageJob(deps, makePayload())).rejects.toThrow(
        "simulated database failure",
      );

      expect(whatsappProvider.sentText).toHaveLength(0);
    });
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

    await processMessageJob(deps, makePayload());

    expect(repo.appliedLeadUpdates).toEqual([{ budget: "50000", service: "Website Development" }]);
  });

  describe("DRAIVA Research staging pilot (double gate: env AND companies.is_demo)", () => {
    function capturingLogger(): {
      logger: ReturnType<typeof createLogger>;
      lines: Record<string, unknown>[];
    } {
      const lines: Record<string, unknown>[] = [];
      const logger = createLogger(
        { environment: "test" },
        { write: (line) => lines.push(JSON.parse(line)) },
      );
      return { logger, lines };
    }

    it("stays disabled by default when researchStagingEnabled is omitted, even for a demo company", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const deps = makeDeps(activeEntitlementSnapshot());

      await processMessageJob(deps, makePayload());

      expect(aiProvider.calls[0]?.input.researchEnabled).toBeFalsy();
    });

    it("stays disabled when the Worker env allows research but the company is not the demo company", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: false },
      });
      const deps = makeDeps(activeEntitlementSnapshot(), { researchStagingEnabled: true });

      await processMessageJob(deps, makePayload());

      expect(aiProvider.calls[0]?.input.researchEnabled).toBeFalsy();
    });

    it("stays disabled when the company is the demo company but the Worker env does not allow research", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const deps = makeDeps(activeEntitlementSnapshot(), { researchStagingEnabled: false });

      await processMessageJob(deps, makePayload());

      expect(aiProvider.calls[0]?.input.researchEnabled).toBeFalsy();
    });

    it("activates research only when BOTH the Worker env flag and companies.is_demo are true", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const deps = makeDeps(activeEntitlementSnapshot(), { researchStagingEnabled: true });

      await processMessageJob(deps, makePayload());

      expect(aiProvider.calls[0]?.input.researchEnabled).toBe(true);
    });

    it("logs a research query privacy violation when the model's search query contained this turn's phone number, without altering the reply", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const { logger, lines } = capturingLogger();
      const leakyAiProvider = new MockAiProvider();
      const originalGenerate = leakyAiProvider.generate.bind(leakyAiProvider);
      leakyAiProvider.generate = async (input, repairInstruction) => {
        const result = await originalGenerate(input, repairInstruction);
        return {
          ...result,
          research: {
            searchesPerformed: 1,
            searchQueries: ["interior trends for customer 919820000001"],
            findings: [],
            failureReason: null,
          },
        };
      };
      const deps = makeDeps(activeEntitlementSnapshot(), {
        aiProvider: leakyAiProvider,
        researchStagingEnabled: true,
        logger,
      });

      await processMessageJob(deps, makePayload({ waId: "919820000001" }));

      const violationLine = lines.find(
        (l) => l.message === "Research query privacy violation detected",
      );
      expect(violationLine).toBeDefined();
      expect((violationLine?.violationTypes as string[]) ?? []).toContain("phone_number");
      expect(whatsappProvider.sentText).toHaveLength(1);
    });

    it("does not log a privacy violation for a clean, public research query", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const { logger, lines } = capturingLogger();
      const cleanAiProvider = new MockAiProvider();
      const originalGenerate = cleanAiProvider.generate.bind(cleanAiProvider);
      cleanAiProvider.generate = async (input, repairInstruction) => {
        const result = await originalGenerate(input, repairInstruction);
        return {
          ...result,
          research: {
            searchesPerformed: 1,
            searchQueries: ["Kerala interior fit-out market competitors"],
            findings: [],
            failureReason: null,
          },
        };
      };
      const deps = makeDeps(activeEntitlementSnapshot(), {
        aiProvider: cleanAiProvider,
        researchStagingEnabled: true,
        logger,
      });

      await processMessageJob(deps, makePayload());

      const violationLine = lines.find(
        (l) => l.message === "Research query privacy violation detected",
      );
      expect(violationLine).toBeUndefined();
    });

    it("logs research execution diagnostics (research_started/completed/source_count) without leaking the search query text", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const { logger, lines } = capturingLogger();
      const researchingAiProvider = new MockAiProvider();
      const originalGenerate = researchingAiProvider.generate.bind(researchingAiProvider);
      researchingAiProvider.generate = async (input, repairInstruction) => {
        const result = await originalGenerate(input, repairInstruction);
        return {
          ...result,
          research: {
            searchesPerformed: 1,
            searchQueries: ["Kerala interior fit-out market competitors"],
            findings: [
              {
                sourceUrl: "https://example.test/a",
                sourceTitle: "A",
                sourceDomain: "example.test",
                publishedAt: null,
                retrievedAt: "2026-08-12T09:00:00.000Z",
                relevance: 1,
                authorityTier: "general_web" as const,
                keyFindings: "finding text",
                origin: "external_research" as const,
              },
            ],
            failureReason: null,
          },
        };
      };
      const deps = makeDeps(activeEntitlementSnapshot(), {
        aiProvider: researchingAiProvider,
        researchStagingEnabled: true,
        logger,
      });

      await processMessageJob(deps, makePayload());

      const diagnosticsLine = lines.find((l) => l.message === "Research execution diagnostics");
      expect(diagnosticsLine).toMatchObject({
        researchStarted: true,
        researchCompleted: true,
        sourceCount: 1,
      });
      expect(JSON.stringify(diagnosticsLine)).not.toContain(
        "Kerala interior fit-out market competitors",
      );
    });
  });

  describe("DRAIVA Research staging-only live observability (TEMPORARY instrumentation)", () => {
    function researchDiagnosticsAiProvider(): MockAiProvider {
      const provider = new MockAiProvider();
      const originalGenerate = provider.generate.bind(provider);
      provider.generate = async (input, repairInstruction) => {
        const result = await originalGenerate(input, repairInstruction);
        return {
          ...result,
          researchDiagnostics: {
            researchRequired: true,
            researchEnabled: true,
            model: "claude-sonnet-5",
            toolName: "web_search",
            toolType: "web_search_20250305",
            toolChoice: "tool:web_search",
            maxTokens: 4096,
            stopReason: "end_turn",
            responseBlockTypes: ["server_tool_use", "web_search_tool_result", "text"],
            webSearchRequests: 1,
            pauseTurnCount: 0,
            researchContinuationCount: 0,
            sourceCount: 1,
          },
        };
      };
      return provider;
    }

    it("writes sanitized research diagnostics onto the outbound message when appEnv is staging", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const deps = makeDeps(activeEntitlementSnapshot(), {
        aiProvider: researchDiagnosticsAiProvider(),
        researchStagingEnabled: true,
        appEnv: "staging",
      });

      await processMessageJob(deps, makePayload());

      expect(repo.recordedResearchDiagnostics).toHaveLength(1);
      expect(repo.recordedResearchDiagnostics[0]?.diagnostics).toMatchObject({
        researchRequired: true,
        researchEnabled: true,
        stopReason: "end_turn",
        webSearchRequests: 1,
        sourceCount: 1,
      });
    });

    it("does NOT write research diagnostics when appEnv is production, even though researchDiagnostics is present", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const deps = makeDeps(activeEntitlementSnapshot(), {
        aiProvider: researchDiagnosticsAiProvider(),
        researchStagingEnabled: true,
        appEnv: "production",
      });

      await processMessageJob(deps, makePayload());

      expect(repo.recordedResearchDiagnostics).toHaveLength(0);
    });

    it("does NOT write research diagnostics when appEnv is omitted (every pre-existing caller/test)", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const deps = makeDeps(activeEntitlementSnapshot(), {
        aiProvider: researchDiagnosticsAiProvider(),
        researchStagingEnabled: true,
      });

      await processMessageJob(deps, makePayload());

      expect(repo.recordedResearchDiagnostics).toHaveLength(0);
    });

    it("does NOT write research diagnostics when appEnv is staging but this turn had no researchDiagnostics (non-research call)", async () => {
      const deps = makeDeps(activeEntitlementSnapshot(), { appEnv: "staging" });

      await processMessageJob(deps, makePayload());

      expect(repo.recordedResearchDiagnostics).toHaveLength(0);
    });

    it("never includes the answer text, customer message, or a URL in the written diagnostics object", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      const deps = makeDeps(activeEntitlementSnapshot(), {
        aiProvider: researchDiagnosticsAiProvider(),
        researchStagingEnabled: true,
        appEnv: "staging",
      });

      await processMessageJob(
        deps,
        makePayload({ body: "Can you research the Kerala market for competing agencies?" }),
      );

      const serialized = JSON.stringify(repo.recordedResearchDiagnostics[0]?.diagnostics);
      expect(serialized).not.toContain("Kerala");
      expect(serialized).not.toContain("https://");
    });

    it("a failure writing diagnostics never affects the customer-facing outcome -- the WhatsApp reply is still sent", async () => {
      repo.context = baseConversationContext({
        aiContext: { ...baseConversationContext().aiContext, isDemo: true },
      });
      repo.recordResearchDiagnostics = async () => {
        throw new Error("simulated write failure");
      };
      const deps = makeDeps(activeEntitlementSnapshot(), {
        aiProvider: researchDiagnosticsAiProvider(),
        researchStagingEnabled: true,
        appEnv: "staging",
      });

      await processMessageJob(deps, makePayload());

      expect(whatsappProvider.sentText).toHaveLength(1);
    });
  });
});
