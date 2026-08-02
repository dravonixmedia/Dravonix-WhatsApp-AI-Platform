import type { ExpiredOutboundMessage, HandoverWorkerRepository } from "@dravonix/handover";
import { createLogger, type LogSink } from "@dravonix/observability";
import { describe, expect, it, vi } from "vitest";
import { runReconciliation } from "../src/reconcile.js";

class FakeHandoverWorkerRepository implements Partial<HandoverWorkerRepository> {
  constructor(private readonly expired: ExpiredOutboundMessage[]) {}
  expireStaleOutboundSends = vi.fn(async () => this.expired);
}

function makeLogger() {
  const lines: Array<{ severity: string; message: string; [key: string]: unknown }> = [];
  const sink: LogSink = { write: (line) => lines.push(JSON.parse(line)) };
  return { logger: createLogger({ environment: "test" }, sink), lines };
}

describe("runReconciliation", () => {
  it("calls expireStaleOutboundSends exactly once and reports zero when nothing is stale", async () => {
    const repo = new FakeHandoverWorkerRepository([]);
    const { logger, lines } = makeLogger();

    const result = await runReconciliation({
      handoverRepo: repo as unknown as HandoverWorkerRepository,
      logger,
    });

    expect(repo.expireStaleOutboundSends).toHaveBeenCalledTimes(1);
    expect(result.expiredCount).toBe(0);
    expect(lines.some((l) => l.severity === "warn")).toBe(false);
  });

  it("logs a warning with the expired message ids when sends are expired", async () => {
    const expired: ExpiredOutboundMessage[] = [
      { id: "msg-1", conversationId: "conv-1", companyId: "company-1", senderType: "ai" },
      { id: "msg-2", conversationId: "conv-2", companyId: "company-1", senderType: "human_agent" },
    ];
    const repo = new FakeHandoverWorkerRepository(expired);
    const { logger, lines } = makeLogger();

    const result = await runReconciliation({
      handoverRepo: repo as unknown as HandoverWorkerRepository,
      logger,
    });

    expect(result.expiredCount).toBe(2);
    const warnLine = lines.find((l) => l.severity === "warn");
    expect(warnLine).toMatchObject({ count: 2, messageIds: ["msg-1", "msg-2"] });
  });

  it("never calls anything WhatsApp-related -- structurally impossible, no such dependency exists", async () => {
    // This Worker's deps type (ReconcileDeps) has no WhatsApp provider field at
    // all, so there is no code path here that could ever send/resend a
    // message -- the RPC itself is the only thing that touches message rows.
    const repo = new FakeHandoverWorkerRepository([]);
    const { logger } = makeLogger();
    await expect(
      runReconciliation({ handoverRepo: repo as unknown as HandoverWorkerRepository, logger }),
    ).resolves.toEqual({ expiredCount: 0 });
  });
});
