import { MockAiProvider } from "@dravonix/ai";
import type { EntitlementRepository, EntitlementSnapshot } from "@dravonix/billing";
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
  recordedOutbound: Array<{ body: string; providerMessageId: string }> = [];
  appliedLeadUpdates: unknown[] = [];
  handoverCalls: Array<{ conversationId: string; reason: string }> = [];

  async loadConversationContext(_conversationId: string): Promise<ConversationContext> {
    return this.context;
  }

  async recordOutboundMessage(input: { body: string; providerMessageId: string }): Promise<void> {
    this.recordedOutbound.push(input);
  }

  async applyLeadUpdates(input: { leadUpdates: unknown }): Promise<void> {
    this.appliedLeadUpdates.push(input.leadUpdates);
  }

  async triggerHandover(input: { conversationId: string; reason: string }): Promise<void> {
    this.handoverCalls.push(input);
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
  let whatsappProvider: MockWhatsAppProvider;
  let aiProvider: MockAiProvider;
  let knowledgeRetriever: { retrieve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repo = new FakeMessageConsumerRepository();
    whatsappProvider = new MockWhatsAppProvider();
    aiProvider = new MockAiProvider();
    knowledgeRetriever = { retrieve: vi.fn(async () => []) };
  });

  function makeDeps(entitlementSnapshot: EntitlementSnapshot): MessageConsumerDeps {
    return {
      repo,
      entitlementRepo: new FakeEntitlementRepository(entitlementSnapshot),
      knowledgeRetriever,
      aiProvider,
      whatsappProvider,
      logger: silentLogger,
    };
  }

  it("generates an AI reply, sends it via WhatsApp, and records the outbound message", async () => {
    const deps = makeDeps(activeEntitlementSnapshot());

    await processMessageJob(deps, makePayload());

    expect(aiProvider.calls).toHaveLength(1);
    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentText[0]?.toWaId).toBe("919820000001");
    expect(repo.recordedOutbound).toHaveLength(1);
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
    expect(repo.recordedOutbound).toHaveLength(0);
  });

  it("never calls Claude or WhatsApp send for a manually suspended company", async () => {
    const deps = makeDeps({ ...activeEntitlementSnapshot(), companyStatus: "manually_suspended" });
    await processMessageJob(deps, makePayload());
    expect(aiProvider.calls).toHaveLength(0);
    expect(whatsappProvider.sentText).toHaveLength(0);
  });

  it("never generates an AI reply while a human agent has taken over the conversation", async () => {
    repo.context = baseConversationContext({ conversationState: "human_active" });
    const deps = makeDeps(activeEntitlementSnapshot());

    await processMessageJob(deps, makePayload());

    expect(aiProvider.calls).toHaveLength(0);
    expect(whatsappProvider.sentText).toHaveLength(0);
  });

  it("never generates an AI reply while a conversation is paused", async () => {
    repo.context = baseConversationContext({ conversationState: "paused" });
    const deps = makeDeps(activeEntitlementSnapshot());
    await processMessageJob(deps, makePayload());
    expect(aiProvider.calls).toHaveLength(0);
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

    await processMessageJob(deps, makePayload());

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

    await processMessageJob(deps, makePayload());

    expect(repo.appliedLeadUpdates).toEqual([{ budget: "50000", service: "Website Development" }]);
  });
});
