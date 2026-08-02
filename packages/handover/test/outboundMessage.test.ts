import type { EntitlementRepository, EntitlementSnapshot } from "@dravonix/billing";
import {
  WhatsAppProviderError,
  type SendAudioInput,
  type SendTextInput,
  type WhatsAppProvider,
} from "@dravonix/whatsapp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifySendError, sendHumanReply } from "../src/outboundMessage.js";
import { FakeHandoverRepository } from "./fakeHandoverRepository.js";

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
  failWith: Error | null = null;

  async sendText(input: SendTextInput) {
    this.sentText.push(input);
    if (this.failWith) throw this.failWith;
    return { providerMessageId: "wamid.MOCK.1" };
  }
  async sendAudio(_input: SendAudioInput) {
    return { providerMessageId: "wamid.MOCK.audio.1" };
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
