import type { EntitlementRepository, EntitlementSnapshot } from "@dravonix/billing";
import {
  WhatsAppProviderError,
  type SendAudioInput,
  type SendTemplateInput,
  type SendTextInput,
  type WhatsAppProvider,
} from "@dravonix/whatsapp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySendError,
  resolveServiceWindowState,
  sendAiOutboundMessage,
  sendHumanReply,
  sendServiceWindowFallback,
  sendServiceWindowReengagementTemplate,
} from "../src/outboundMessage.js";
import {
  NoServiceWindowFallbackTemplateError,
  WhatsAppServiceWindowClosedError,
} from "../src/errors.js";
import type { HandoverWorkerRepository } from "../src/repository.js";
import type {
  MessageChannelType,
  OutboundDeliveryStatus,
  OutboundFinalizeResult,
  OutboundReservation,
  ServiceWindowState,
} from "../src/types.js";
import { FakeHandoverRepository } from "./fakeHandoverRepository.js";

const RECENT_ISO = new Date().toISOString();
const EXPIRED_ISO = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

/**
 * Minimal in-memory double for HandoverWorkerRepository, focused on the
 * service-window/template-fallback behavior this batch adds --
 * apps/workers/message-consumer and voice-consumer have their own separate
 * fakes for the fuller AI-reply pipeline; this one exists purely to unit
 * test sendAiOutboundMessage/resolveServiceWindowState/
 * sendServiceWindowFallback in isolation.
 */
class FakeHandoverWorkerRepository implements HandoverWorkerRepository {
  serviceWindowState: ServiceWindowState = {
    lastCustomerMessageAt: RECENT_ISO,
    fallbackTemplate: null,
  };
  private readonly messages = new Map<
    string,
    { outboundStatus: OutboundDeliveryStatus; providerMessageId: string | null }
  >();
  private readonly bySourceAndChannel = new Map<string, string>();
  private counter = 0;

  async getServiceWindowState(_sourceMessageId: string): Promise<ServiceWindowState> {
    return this.serviceWindowState;
  }

  async reserveAiOutboundMessage(
    sourceMessageId: string,
    channelType: MessageChannelType,
  ): Promise<OutboundReservation> {
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
    return { id, claimed: true, outboundStatus: "sending", providerMessageId: null };
  }

  async finalizeAiOutboundMessage(
    messageId: string,
    status: OutboundDeliveryStatus,
    providerMessageId: string | null,
  ): Promise<OutboundFinalizeResult> {
    const msg = this.messages.get(messageId);
    if (!msg) throw new Error("message_not_found");
    msg.outboundStatus = status;
    msg.providerMessageId = providerMessageId ?? msg.providerMessageId;
    return { id: messageId, outboundStatus: status };
  }

  getMessageState(messageId: string) {
    const msg = this.messages.get(messageId);
    if (!msg) throw new Error("message_not_found");
    return msg;
  }

  async triggerHandover(): Promise<never> {
    throw new Error("not implemented in this fake");
  }
  async expireStaleOutboundSends() {
    return [];
  }
  async getMessageForReconciliation() {
    return null;
  }
  async reconcileOutboundMessage(): Promise<never> {
    throw new Error("not implemented in this fake");
  }
}

const COMPANY_ID = "company-1";
const CONVERSATION_ID = "conv-1";
const MEMBER_ID = "member-1";

function activeEntitlementSnapshot(): EntitlementSnapshot {
  return { companyStatus: "active", subscriptionState: "active", features: {}, usage: {} };
}

class FakeEntitlementRepository implements EntitlementRepository {
  constructor(private readonly snapshot: EntitlementSnapshot) {}
  getSnapshot = vi.fn(async (_companyId: string) => this.snapshot);
}

class ControllableWhatsAppProvider implements WhatsAppProvider {
  sentText: SendTextInput[] = [];
  sentTemplate: SendTemplateInput[] = [];
  failWith: Error | null = null;
  failTemplateWith: Error | null = null;

  async sendText(input: SendTextInput) {
    this.sentText.push(input);
    if (this.failWith) throw this.failWith;
    return { providerMessageId: "wamid.MOCK.1" };
  }
  async sendAudio(_input: SendAudioInput) {
    return { providerMessageId: "wamid.MOCK.audio.1" };
  }
  async sendTemplate(input: SendTemplateInput) {
    this.sentTemplate.push(input);
    if (this.failTemplateWith) throw this.failTemplateWith;
    return { providerMessageId: "wamid.MOCK.template.1" };
  }
  async getMediaMetadata() {
    return { url: "https://mock.local", mimeType: null, sizeBytes: null };
  }
  async downloadMedia() {
    return new ArrayBuffer(0);
  }
  async uploadMedia() {
    return { mediaId: "media-1" };
  }
}

describe("classifySendError", () => {
  it("classifies a 429/5xx WhatsAppProviderError as a retryable send_failed", () => {
    expect(classifySendError(new WhatsAppProviderError("rate limited", 429)).retryable).toBe(true);
    expect(classifySendError(new WhatsAppProviderError("rate limited", 429)).status).toBe(
      "send_failed",
    );
    expect(classifySendError(new WhatsAppProviderError("server error", 500)).retryable).toBe(true);
  });

  it("classifies a 4xx (non-429) WhatsAppProviderError as a permanent, non-retryable send_failed", () => {
    const classification = classifySendError(
      new WhatsAppProviderError("bad request", 400, "131009"),
    );
    expect(classification.status).toBe("send_failed");
    expect(classification.retryable).toBe(false);
    expect(classification.errorCode).toBe("131009");
  });

  it("classifies an ambiguous (non-provider) error as delivery_unknown, never a guessed failure", () => {
    const classification = classifySendError(new Error("network timeout"));
    expect(classification.status).toBe("delivery_unknown");
    expect(classification.retryable).toBeNull();
    expect(classification.errorCode).toBeNull();
  });
});

describe("sendHumanReply", () => {
  let repo: FakeHandoverRepository;
  let whatsappProvider: ControllableWhatsAppProvider;
  let entitlementRepo: FakeEntitlementRepository;

  beforeEach(() => {
    repo = new FakeHandoverRepository(
      [
        {
          id: CONVERSATION_ID,
          companyId: COMPANY_ID,
          state: "human_active",
          assignedMemberId: MEMBER_ID,
        },
      ],
      [{ id: MEMBER_ID, companyId: COMPANY_ID, permissions: ["conversations.reply"] }],
    );
    repo.asMember(MEMBER_ID);
    whatsappProvider = new ControllableWhatsAppProvider();
    entitlementRepo = new FakeEntitlementRepository(activeEntitlementSnapshot());
  });

  const baseInput = {
    companyId: COMPANY_ID,
    conversationId: CONVERSATION_ID,
    body: "hello",
    idempotencyKey: "compose-1",
    phoneNumberId: "phone-1",
    toWaId: "15551234567",
  };

  it("sends and finalizes as sent on a successful WhatsApp call", async () => {
    const result = await sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput);
    expect(result.alreadyHandled).toBe(false);
    expect(result.outboundStatus).toBe("sent");
    expect(whatsappProvider.sentText).toHaveLength(1);
  });

  it("finalizes as delivery_unknown (never send_failed) on an ambiguous provider error", async () => {
    whatsappProvider.failWith = new Error("connection reset");
    const result = await sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput);
    expect(result.outboundStatus).toBe("delivery_unknown");
    const message = repo.getMessageState(result.messageId);
    expect(message.outboundStatus).toBe("delivery_unknown");
  });

  it("finalizes as send_failed for a definitive provider rejection", async () => {
    whatsappProvider.failWith = new WhatsAppProviderError("invalid recipient", 400, "131026");
    const result = await sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput);
    expect(result.outboundStatus).toBe("send_failed");
  });

  it("skips the WhatsApp call entirely on a repeat submission with the same idempotency key (already claimed)", async () => {
    const first = await sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput);
    expect(first.alreadyHandled).toBe(false);

    const second = await sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput);
    expect(second.alreadyHandled).toBe(true);
    expect(second.messageId).toBe(first.messageId);
    expect(whatsappProvider.sentText).toHaveLength(1);
  });

  it("rejects outside human_active without ever attempting a WhatsApp send", async () => {
    repo.getConversationState(CONVERSATION_ID).state = "handover_requested";
    await expect(
      sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput),
    ).rejects.toThrow("invalid_state_transition");
    expect(whatsappProvider.sentText).toHaveLength(0);
  });

  it("rejects a caller who is not the assigned member and lacks the reassign override", async () => {
    repo = new FakeHandoverRepository(
      [
        {
          id: CONVERSATION_ID,
          companyId: COMPANY_ID,
          state: "human_active",
          assignedMemberId: "someone-else",
        },
      ],
      [{ id: MEMBER_ID, companyId: COMPANY_ID, permissions: ["conversations.reply"] }],
    );
    repo.asMember(MEMBER_ID);
    await expect(
      sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput),
    ).rejects.toThrow("conversation_not_assigned_to_caller");
    expect(whatsappProvider.sentText).toHaveLength(0);
  });

  it("blocks an ordinary free-form reply outside the 24-hour service window without reserving or sending anything (item 15)", async () => {
    repo.setLastCustomerMessageAt(EXPIRED_ISO);
    await expect(
      sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput),
    ).rejects.toThrow(WhatsAppServiceWindowClosedError);
    expect(whatsappProvider.sentText).toHaveLength(0);
    expect(whatsappProvider.sentTemplate).toHaveLength(0);
  });

  it("allows an ordinary free-form reply inside the service window (item 14)", async () => {
    repo.setLastCustomerMessageAt(RECENT_ISO);
    const result = await sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput);
    expect(result.outboundStatus).toBe("sent");
  });

  it("blocks when there has never been a qualifying inbound customer message (item 3)", async () => {
    repo.setLastCustomerMessageAt(null);
    await expect(
      sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput),
    ).rejects.toThrow(WhatsAppServiceWindowClosedError);
  });

  it("allows an authorized manager override to reply on an assigned employee's conversation", async () => {
    repo = new FakeHandoverRepository(
      [
        {
          id: CONVERSATION_ID,
          companyId: COMPANY_ID,
          state: "human_active",
          assignedMemberId: "someone-else",
        },
      ],
      [
        {
          id: MEMBER_ID,
          companyId: COMPANY_ID,
          permissions: ["conversations.reply", "conversations.reassign"],
        },
      ],
    );
    repo.asMember(MEMBER_ID);
    const result = await sendHumanReply(repo, whatsappProvider, entitlementRepo, baseInput);
    expect(result.outboundStatus).toBe("sent");
    // Override never silently reassigns the conversation.
    expect(repo.getConversationState(CONVERSATION_ID).assignedMemberId).toBe("someone-else");
  });
});

describe("resolveServiceWindowState", () => {
  it("reports open when the most recent qualifying inbound message is within 24 hours (item 1)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    workerRepo.serviceWindowState = { lastCustomerMessageAt: RECENT_ISO, fallbackTemplate: null };
    const state = await resolveServiceWindowState(workerRepo, "src-1");
    expect(state.open).toBe(true);
  });

  it("reports closed when the most recent qualifying inbound message is more than 24 hours old (item 2)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    workerRepo.serviceWindowState = { lastCustomerMessageAt: EXPIRED_ISO, fallbackTemplate: null };
    const state = await resolveServiceWindowState(workerRepo, "src-1");
    expect(state.open).toBe(false);
  });

  it("reports closed when there has never been a qualifying inbound message (item 3)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    workerRepo.serviceWindowState = { lastCustomerMessageAt: null, fallbackTemplate: null };
    const state = await resolveServiceWindowState(workerRepo, "src-1");
    expect(state.open).toBe(false);
  });
});

describe("sendAiOutboundMessage (Meta/WhatsApp Batch 2 window gating)", () => {
  const baseAiInput = {
    sourceMessageId: "src-1",
    channelType: "text" as const,
    phoneNumberId: "phone-1",
    toWaId: "15551234567",
    body: "Here is the AI's free-form answer",
  };

  it("sends free-form text as before when inside the window (item 9)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    workerRepo.serviceWindowState = { lastCustomerMessageAt: RECENT_ISO, fallbackTemplate: null };
    const whatsappProvider = new ControllableWhatsAppProvider();
    const result = await sendAiOutboundMessage(workerRepo, whatsappProvider, baseAiInput);
    expect(result.outboundStatus).toBe("sent");
    expect(whatsappProvider.sentText).toHaveLength(1);
    expect(whatsappProvider.sentTemplate).toHaveLength(0);
  });

  it("never sends the AI's free-form text outside the window -- redirects to the template fallback instead (item 10)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    workerRepo.serviceWindowState = {
      lastCustomerMessageAt: EXPIRED_ISO,
      fallbackTemplate: { id: "tpl-1", name: "reengagement_v1", language: "en" },
    };
    const whatsappProvider = new ControllableWhatsAppProvider();
    const result = await sendAiOutboundMessage(workerRepo, whatsappProvider, baseAiInput);
    expect(whatsappProvider.sentText).toHaveLength(0);
    expect(result.outboundStatus).toBe("sent");
    expect(whatsappProvider.sentTemplate).toEqual([
      {
        phoneNumberId: "phone-1",
        toWaId: "15551234567",
        templateName: "reengagement_v1",
        languageCode: "en",
        bodyParameters: [],
      },
    ]);
  });
});

describe("sendServiceWindowFallback", () => {
  it("sends the configured template and stores the real provider message id (items 16, 21)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    const whatsappProvider = new ControllableWhatsAppProvider();
    const result = await sendServiceWindowFallback(workerRepo, whatsappProvider, {
      sourceMessageId: "src-1",
      phoneNumberId: "phone-1",
      toWaId: "15551234567",
      fallbackTemplate: { id: "tpl-1", name: "reengagement_v1", language: "en" },
    });
    expect(result.outboundStatus).toBe("sent");
    const stored = workerRepo.getMessageState(result.messageId);
    expect(stored.providerMessageId).toBe("wamid.MOCK.template.1");
  });

  it("fails safely and visibly, without any provider call, when no fallback template is configured (item 17)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    const whatsappProvider = new ControllableWhatsAppProvider();
    const result = await sendServiceWindowFallback(workerRepo, whatsappProvider, {
      sourceMessageId: "src-1",
      phoneNumberId: "phone-1",
      toWaId: "15551234567",
      fallbackTemplate: null,
    });
    expect(result.outboundStatus).toBe("send_failed");
    expect(whatsappProvider.sentTemplate).toHaveLength(0);
  });

  it("sanitizes a provider rejection of the template send itself, never marking it delivered (item 22)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    const whatsappProvider = new ControllableWhatsAppProvider();
    whatsappProvider.failTemplateWith = new WhatsAppProviderError(
      "template rejected",
      400,
      "132000",
    );
    const result = await sendServiceWindowFallback(workerRepo, whatsappProvider, {
      sourceMessageId: "src-1",
      phoneNumberId: "phone-1",
      toWaId: "15551234567",
      fallbackTemplate: { id: "tpl-1", name: "reengagement_v1", language: "en" },
    });
    expect(result.outboundStatus).toBe("send_failed");
  });

  it("never duplicates the template send on a queue redelivery of the same inbound message (item 20)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    const whatsappProvider = new ControllableWhatsAppProvider();
    const input = {
      sourceMessageId: "src-1",
      phoneNumberId: "phone-1",
      toWaId: "15551234567",
      fallbackTemplate: { id: "tpl-1", name: "reengagement_v1", language: "en" },
    };
    const first = await sendServiceWindowFallback(workerRepo, whatsappProvider, input);
    const redelivered = await sendServiceWindowFallback(workerRepo, whatsappProvider, input);
    expect(redelivered.alreadyHandled).toBe(true);
    expect(redelivered.messageId).toBe(first.messageId);
    expect(whatsappProvider.sentTemplate).toHaveLength(1);
  });

  it("a text-channel and an audio-channel attempt for the SAME inbound message send exactly one template, not two (voice text_and_voice case)", async () => {
    const workerRepo = new FakeHandoverWorkerRepository();
    const whatsappProvider = new ControllableWhatsAppProvider();
    const input = {
      sourceMessageId: "src-1",
      phoneNumberId: "phone-1",
      toWaId: "15551234567",
      fallbackTemplate: { id: "tpl-1", name: "reengagement_v1", language: "en" },
    };
    // Simulates processVoiceJob's text branch (via sendAiOutboundMessage's
    // internal redirect) and its separate manual audio branch both racing
    // to the same template fallback for one voice reply.
    const textAttempt = await sendServiceWindowFallback(workerRepo, whatsappProvider, input);
    const audioAttempt = await sendServiceWindowFallback(workerRepo, whatsappProvider, input);
    expect(textAttempt.alreadyHandled).toBe(false);
    expect(audioAttempt.alreadyHandled).toBe(true);
    expect(whatsappProvider.sentTemplate).toHaveLength(1);
  });
});

describe("sendServiceWindowReengagementTemplate (human-initiated, item 18/19 covered at the DB layer)", () => {
  const CONVERSATION_ID_2 = "conv-2";
  const MEMBER_ID_2 = "member-2";

  function makeRepoWithTemplate(template: { id: string; name: string; language: string } | null) {
    const repo = new FakeHandoverRepository(
      [
        {
          id: CONVERSATION_ID_2,
          companyId: COMPANY_ID,
          state: "human_active",
          assignedMemberId: MEMBER_ID_2,
        },
      ],
      [{ id: MEMBER_ID_2, companyId: COMPANY_ID, permissions: ["conversations.reply"] }],
    );
    repo.asMember(MEMBER_ID_2);
    repo.setFallbackTemplate(template);
    return repo;
  }

  it("sends the resolved template and stores the real provider message id", async () => {
    const repo = makeRepoWithTemplate({ id: "tpl-1", name: "reengagement_v1", language: "en" });
    const whatsappProvider = new ControllableWhatsAppProvider();
    const result = await sendServiceWindowReengagementTemplate(repo, whatsappProvider, {
      conversationId: CONVERSATION_ID_2,
      idempotencyKey: "reengage-1",
      phoneNumberId: "phone-1",
      toWaId: "15551234567",
    });
    expect(result.outboundStatus).toBe("sent");
    expect(whatsappProvider.sentTemplate).toEqual([
      {
        phoneNumberId: "phone-1",
        toWaId: "15551234567",
        templateName: "reengagement_v1",
        languageCode: "en",
        bodyParameters: [],
      },
    ]);
  });

  it("throws a typed NoServiceWindowFallbackTemplateError rather than the RPC's bare error string or silently sending nothing (item 17)", async () => {
    // Corrected during Batch 2 staging verification: the bare
    // "no_fallback_template_configured" RPC string used to propagate
    // unchanged, which apps/web's Server Action then let escape as an
    // unhandled exception -- redacted by Next.js in production into a
    // generic, undiagnosable digest error. It is now translated into this
    // typed, safe-to-display domain error instead.
    const repo = makeRepoWithTemplate(null);
    const whatsappProvider = new ControllableWhatsAppProvider();
    await expect(
      sendServiceWindowReengagementTemplate(repo, whatsappProvider, {
        conversationId: CONVERSATION_ID_2,
        idempotencyKey: "reengage-1",
        phoneNumberId: "phone-1",
        toWaId: "15551234567",
      }),
    ).rejects.toThrow(NoServiceWindowFallbackTemplateError);
    expect(whatsappProvider.sentTemplate).toHaveLength(0);
  });
});
