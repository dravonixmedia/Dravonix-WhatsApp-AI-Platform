import { PermissionDeniedError, TenantIsolationViolationError } from "@dravonix/core";
import type { AuditLogEntry, AuditLogWriter } from "@dravonix/observability";
import type { TenantContext } from "@dravonix/tenant";
import { describe, expect, it } from "vitest";
import { HandoverMessageNotFoundError, HandoverNotAnAiMessageError } from "../src/errors.js";
import { reconcileAiOutboundMessage } from "../src/reconcileAiOutboundMessage.js";
import type {
  HandoverWorkerRepository,
  OutboundMessageForReconciliation,
} from "../src/repository.js";
import type {
  ExpiredOutboundMessage,
  MessageChannelType,
  OutboundDeliveryStatus,
  OutboundFinalizeResult,
  OutboundReservation,
} from "../src/types.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const MANAGER_USER_ID = "user-manager-1";
const AI_MESSAGE_ID = "msg-ai-1";

/**
 * Fake HandoverWorkerRepository exercising only the two methods
 * reconcileAiOutboundMessage actually calls -- the rest throw if invoked,
 * since a bug that starts calling e.g. reserveAiOutboundMessage here would
 * mean this trusted path started doing something it structurally should
 * never need to (like sending a WhatsApp message).
 */
class FakeWorkerRepository implements HandoverWorkerRepository {
  reconcileCalls: Array<{
    messageId: string;
    resolution: "confirm_sent" | "confirm_not_sent";
    providerMessageId: string | null | undefined;
    reason: string | null | undefined;
  }> = [];

  constructor(
    private readonly messages: Map<string, OutboundMessageForReconciliation>,
    private readonly finalStatus: OutboundDeliveryStatus = "sent",
  ) {}

  async getMessageForReconciliation(
    messageId: string,
  ): Promise<OutboundMessageForReconciliation | null> {
    return this.messages.get(messageId) ?? null;
  }

  async reconcileOutboundMessage(
    messageId: string,
    resolution: "confirm_sent" | "confirm_not_sent",
    providerMessageId?: string | null,
    reason?: string | null,
  ): Promise<OutboundFinalizeResult> {
    this.reconcileCalls.push({ messageId, resolution, providerMessageId, reason });
    return { id: messageId, outboundStatus: this.finalStatus };
  }

  async triggerHandover(): Promise<never> {
    throw new Error("must not be called by reconcileAiOutboundMessage");
  }
  async reserveAiOutboundMessage(
    _sourceMessageId: string,
    _channelType: MessageChannelType,
  ): Promise<OutboundReservation> {
    throw new Error("must not be called by reconcileAiOutboundMessage");
  }
  async finalizeAiOutboundMessage(): Promise<OutboundFinalizeResult> {
    throw new Error("must not be called by reconcileAiOutboundMessage");
  }
  async expireStaleOutboundSends(): Promise<ExpiredOutboundMessage[]> {
    throw new Error("must not be called by reconcileAiOutboundMessage");
  }
}

class FakeAuditLogWriter implements AuditLogWriter {
  entries: AuditLogEntry[] = [];
  async write(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

function managerContext(companyId: string): TenantContext {
  return {
    userId: MANAGER_USER_ID,
    membership: { companyId, role: "manager", permissions: new Set(["conversations.reconcile"]) },
    platformRole: null,
  };
}

function agentContext(companyId: string): TenantContext {
  return {
    userId: "user-agent-1",
    membership: { companyId, role: "agent", permissions: new Set(["conversations.reply"]) },
    platformRole: null,
  };
}

describe("reconcileAiOutboundMessage", () => {
  it("rejects a normal agent without conversations.reconcile", async () => {
    const messages = new Map([
      [
        AI_MESSAGE_ID,
        {
          id: AI_MESSAGE_ID,
          companyId: COMPANY_A,
          senderType: "ai" as const,
          outboundStatus: "delivery_unknown" as const,
        },
      ],
    ]);
    const repo = new FakeWorkerRepository(messages);
    const auditWriter = new FakeAuditLogWriter();

    await expect(
      reconcileAiOutboundMessage(repo, auditWriter, agentContext(COMPANY_A), {
        messageId: AI_MESSAGE_ID,
        resolution: "confirm_sent",
        reason: "checked Meta dashboard",
      }),
    ).rejects.toThrow(PermissionDeniedError);

    expect(repo.reconcileCalls).toHaveLength(0);
    expect(auditWriter.entries).toHaveLength(0);
  });

  it("allows an authorized manager to reconcile an AI message", async () => {
    const messages = new Map([
      [
        AI_MESSAGE_ID,
        {
          id: AI_MESSAGE_ID,
          companyId: COMPANY_A,
          senderType: "ai" as const,
          outboundStatus: "delivery_unknown" as const,
        },
      ],
    ]);
    const repo = new FakeWorkerRepository(messages, "sent");
    const auditWriter = new FakeAuditLogWriter();

    const result = await reconcileAiOutboundMessage(repo, auditWriter, managerContext(COMPANY_A), {
      messageId: AI_MESSAGE_ID,
      resolution: "confirm_sent",
      reason: "confirmed delivered in Meta Business dashboard",
    });

    expect(result.outboundStatus).toBe("sent");
    expect(repo.reconcileCalls).toEqual([
      {
        messageId: AI_MESSAGE_ID,
        resolution: "confirm_sent",
        providerMessageId: null,
        reason: "confirmed delivered in Meta Business dashboard",
      },
    ]);
  });

  it("rejects a cross-tenant message id (the message belongs to a different company than the caller's)", async () => {
    const messages = new Map([
      [
        AI_MESSAGE_ID,
        {
          id: AI_MESSAGE_ID,
          companyId: COMPANY_B,
          senderType: "ai" as const,
          outboundStatus: "delivery_unknown" as const,
        },
      ],
    ]);
    const repo = new FakeWorkerRepository(messages);
    const auditWriter = new FakeAuditLogWriter();

    await expect(
      reconcileAiOutboundMessage(repo, auditWriter, managerContext(COMPANY_A), {
        messageId: AI_MESSAGE_ID,
        resolution: "confirm_sent",
        reason: "cross tenant attempt",
      }),
    ).rejects.toThrow(TenantIsolationViolationError);

    expect(repo.reconcileCalls).toHaveLength(0);
    expect(auditWriter.entries).toHaveLength(0);
  });

  it("rejects a message id that does not exist", async () => {
    const repo = new FakeWorkerRepository(new Map());
    const auditWriter = new FakeAuditLogWriter();

    await expect(
      reconcileAiOutboundMessage(repo, auditWriter, managerContext(COMPANY_A), {
        messageId: "does-not-exist",
        resolution: "confirm_sent",
        reason: "test",
      }),
    ).rejects.toThrow(HandoverMessageNotFoundError);
  });

  it("rejects a human-agent message -- this path is AI-messages only", async () => {
    const messages = new Map([
      [
        AI_MESSAGE_ID,
        {
          id: AI_MESSAGE_ID,
          companyId: COMPANY_A,
          senderType: "human_agent" as const,
          outboundStatus: "delivery_unknown" as const,
        },
      ],
    ]);
    const repo = new FakeWorkerRepository(messages);
    const auditWriter = new FakeAuditLogWriter();

    await expect(
      reconcileAiOutboundMessage(repo, auditWriter, managerContext(COMPANY_A), {
        messageId: AI_MESSAGE_ID,
        resolution: "confirm_sent",
        reason: "test",
      }),
    ).rejects.toThrow(HandoverNotAnAiMessageError);

    expect(repo.reconcileCalls).toHaveLength(0);
  });

  it("records an audit event with actor, reason, previous state, and final state", async () => {
    const messages = new Map([
      [
        AI_MESSAGE_ID,
        {
          id: AI_MESSAGE_ID,
          companyId: COMPANY_A,
          senderType: "ai" as const,
          outboundStatus: "delivery_unknown" as const,
        },
      ],
    ]);
    const repo = new FakeWorkerRepository(messages, "send_failed");
    const auditWriter = new FakeAuditLogWriter();

    await reconcileAiOutboundMessage(repo, auditWriter, managerContext(COMPANY_A), {
      messageId: AI_MESSAGE_ID,
      resolution: "confirm_not_sent",
      reason: "Meta dashboard shows this was never delivered",
    });

    expect(auditWriter.entries).toHaveLength(1);
    expect(auditWriter.entries[0]).toMatchObject({
      companyId: COMPANY_A,
      actorUserId: MANAGER_USER_ID,
      actorType: "user",
      action: "handover.ai_outbound_reconciled_by_manager",
      targetType: "message",
      targetId: AI_MESSAGE_ID,
      metadata: {
        resolution: "confirm_not_sent",
        reason: "Meta dashboard shows this was never delivered",
        previous_status: "delivery_unknown",
        final_status: "send_failed",
      },
    });
  });

  it("forwards a supplied providerMessageId through to the repository unchanged", async () => {
    const messages = new Map([
      [
        AI_MESSAGE_ID,
        {
          id: AI_MESSAGE_ID,
          companyId: COMPANY_A,
          senderType: "ai" as const,
          outboundStatus: "delivery_unknown" as const,
        },
      ],
    ]);
    const repo = new FakeWorkerRepository(messages, "sent");
    const auditWriter = new FakeAuditLogWriter();

    await reconcileAiOutboundMessage(repo, auditWriter, managerContext(COMPANY_A), {
      messageId: AI_MESSAGE_ID,
      resolution: "confirm_sent",
      reason: "confirmed via Meta Business dashboard",
      providerMessageId: "wamid.CONFIRMED_ID",
    });

    expect(repo.reconcileCalls).toEqual([
      {
        messageId: AI_MESSAGE_ID,
        resolution: "confirm_sent",
        providerMessageId: "wamid.CONFIRMED_ID",
        reason: "confirmed via Meta Business dashboard",
      },
    ]);
  });

  it("never calls any AI-send/reserve capability -- structurally cannot send a WhatsApp message", async () => {
    // FakeWorkerRepository's triggerHandover/reserveAiOutboundMessage/
    // finalizeAiOutboundMessage all throw if called at all -- this
    // function's only dependency is HandoverWorkerRepository, which has no
    // WhatsApp provider anywhere in its interface, so there is no code path
    // by which this could ever place a real send.
    const messages = new Map([
      [
        AI_MESSAGE_ID,
        {
          id: AI_MESSAGE_ID,
          companyId: COMPANY_A,
          senderType: "ai" as const,
          outboundStatus: "delivery_unknown" as const,
        },
      ],
    ]);
    const repo = new FakeWorkerRepository(messages);
    const auditWriter = new FakeAuditLogWriter();

    await expect(
      reconcileAiOutboundMessage(repo, auditWriter, managerContext(COMPANY_A), {
        messageId: AI_MESSAGE_ID,
        resolution: "confirm_sent",
        reason: "test",
      }),
    ).resolves.toBeDefined();
  });
});
