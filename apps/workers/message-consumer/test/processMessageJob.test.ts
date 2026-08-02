import { MockAiProvider } from "@dravonix/ai";
import type { EntitlementRepository, EntitlementSnapshot } from "@dravonix/billing";
import type { ConversationState } from "@dravonix/core";
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

  async loadConversationContext(_conversationId: string): Promise<ConversationContext> {
    return this.context;
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

  function makeDeps(entitlementSnapshot: EntitlementSnapshot): MessageConsumerDeps {
    return {
      repo,
      handoverRepo,
      entitlementRepo: new FakeEntitlementRepository(entitlementSnapshot),
      knowledgeRetriever,
      aiProvider,
      whatsappProvider,
      logger: silentLogger,
    };
  }

  it("generates an AI reply and sends it via WhatsApp", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());

    await processMessageJob(deps, makePayload());

    expect(aiProvider.calls).toHaveLength(1);
    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentText[0]?.toWaId).toBe("919820000001");
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
          "We're unable to listen to or transcribe voice messages on our end. Our team will also " +
          "follow up with you shortly. In the meantime, we offer website development and AI automation.",
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
    expect(sentBody).not.toMatch(/follow up/i);

    expect(handoverRepo.handoverCalls).toHaveLength(0);
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
});
