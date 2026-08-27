import { createLogger, type LogSink } from "@dravonix/observability";
import { describe, expect, it, vi } from "vitest";
import type { BillingSchedulerRepository } from "../src/billingRepository.js";
import { runBillingLifecycle } from "../src/runBillingLifecycle.js";

function makeLogger() {
  const lines: Array<{ severity: string; message: string; [key: string]: unknown }> = [];
  const sink: LogSink = { write: (line) => lines.push(JSON.parse(line)) };
  return { logger: createLogger({ environment: "test" }, sink), lines };
}

function makeRepo(overrides: Partial<BillingSchedulerRepository> = {}): BillingSchedulerRepository {
  return {
    generateDueInvoices: vi.fn(async () => []),
    advanceOverdueSubscriptions: vi.fn(async () => []),
    suspendExpiredGraceSubscriptions: vi.fn(async () => []),
    finalizeScheduledCancellations: vi.fn(async () => []),
    sendDueReminders: vi.fn(async () => []),
    aggregateUsage: vi.fn(async () => ({ companiesProcessed: 0, summariesUpserted: 0 })),
    ...overrides,
  };
}

describe("runBillingLifecycle", () => {
  it("calls all six steps exactly once, in dependency order (generate, advance, suspend, finalize-cancellations, remind, aggregate-usage)", async () => {
    const callOrder: string[] = [];
    const repo = makeRepo({
      generateDueInvoices: vi.fn(async () => {
        callOrder.push("generate");
        return [];
      }),
      advanceOverdueSubscriptions: vi.fn(async () => {
        callOrder.push("advance");
        return [];
      }),
      suspendExpiredGraceSubscriptions: vi.fn(async () => {
        callOrder.push("suspend");
        return [];
      }),
      finalizeScheduledCancellations: vi.fn(async () => {
        callOrder.push("finalize-cancellations");
        return [];
      }),
      sendDueReminders: vi.fn(async () => {
        callOrder.push("remind");
        return [];
      }),
      aggregateUsage: vi.fn(async () => {
        callOrder.push("aggregate-usage");
        return { companiesProcessed: 0, summariesUpserted: 0 };
      }),
    });
    const { logger } = makeLogger();

    await runBillingLifecycle({ billingRepo: repo, logger });

    expect(repo.generateDueInvoices).toHaveBeenCalledTimes(1);
    expect(repo.advanceOverdueSubscriptions).toHaveBeenCalledTimes(1);
    expect(repo.suspendExpiredGraceSubscriptions).toHaveBeenCalledTimes(1);
    expect(repo.finalizeScheduledCancellations).toHaveBeenCalledTimes(1);
    expect(repo.sendDueReminders).toHaveBeenCalledTimes(1);
    expect(repo.aggregateUsage).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "generate",
      "advance",
      "suspend",
      "finalize-cancellations",
      "remind",
      "aggregate-usage",
    ]);
  });

  it("reports zero counts and logs nothing above debug when nothing happened", async () => {
    const repo = makeRepo();
    const { logger, lines } = makeLogger();

    const result = await runBillingLifecycle({ billingRepo: repo, logger });

    expect(result).toEqual({
      invoicesGenerated: 0,
      subscriptionsAdvanced: 0,
      subscriptionsSuspended: 0,
      cancellationsFinalized: 0,
      remindersSent: 0,
      usageSummariesUpserted: 0,
    });
    expect(lines.some((l) => l.severity === "warn" || l.severity === "error")).toBe(false);
  });

  it("reports the usage-summaries-upserted count and logs it at info", async () => {
    const repo = makeRepo({
      aggregateUsage: vi.fn(async () => ({ companiesProcessed: 3, summariesUpserted: 5 })),
    });
    const { logger, lines } = makeLogger();

    const result = await runBillingLifecycle({ billingRepo: repo, logger });

    expect(result.usageSummariesUpserted).toBe(5);
    const infoLines = lines.filter((l) => l.severity === "info");
    expect(
      infoLines.some((l) => l.message === "Aggregated usage_events into usage_summaries"),
    ).toBe(true);
  });

  it("finalizes scheduled cancellations before sending reminders, so a subscription cancelled this pass never gets a reminder in the same pass", async () => {
    const repo = makeRepo({
      finalizeScheduledCancellations: vi.fn(async () => [
        { companyId: "company-3", subscriptionId: "sub-3" },
      ]),
    });
    const { logger, lines } = makeLogger();

    const result = await runBillingLifecycle({ billingRepo: repo, logger });

    expect(result.cancellationsFinalized).toBe(1);
    const infoLines = lines.filter((l) => l.severity === "info");
    expect(
      infoLines.some((l) => l.message === "Finalized scheduled subscription cancellations"),
    ).toBe(true);
  });

  it("logs a warning (not just info) when subscriptions are advanced into grace period or suspended -- these are money-relevant state changes", async () => {
    const repo = makeRepo({
      advanceOverdueSubscriptions: vi.fn(async () => [
        { companyId: "company-1", subscriptionId: "sub-1", newState: "grace_period" },
      ]),
      suspendExpiredGraceSubscriptions: vi.fn(async () => [
        { companyId: "company-2", subscriptionId: "sub-2" },
      ]),
    });
    const { logger, lines } = makeLogger();

    const result = await runBillingLifecycle({ billingRepo: repo, logger });

    expect(result.subscriptionsAdvanced).toBe(1);
    expect(result.subscriptionsSuspended).toBe(1);
    const warnLines = lines.filter((l) => l.severity === "warn");
    expect(warnLines).toHaveLength(2);
    expect(warnLines[0]).toMatchObject({ count: 1, companyIds: ["company-1"] });
    expect(warnLines[1]).toMatchObject({ count: 1, companyIds: ["company-2"] });
  });

  it("reports the correct counts when invoices are generated and reminders are sent", async () => {
    const repo = makeRepo({
      generateDueInvoices: vi.fn(async () => [
        { companyId: "company-1", invoiceId: "inv-1", invoiceNumber: "DRV-2026-000001" },
        { companyId: "company-2", invoiceId: "inv-2", invoiceNumber: "DRV-2026-000002" },
      ]),
      sendDueReminders: vi.fn(async () => [
        { companyId: "company-1", invoiceId: "inv-1", stage: "due_in_7" },
      ]),
    });
    const { logger } = makeLogger();

    const result = await runBillingLifecycle({ billingRepo: repo, logger });

    expect(result.invoicesGenerated).toBe(2);
    expect(result.remindersSent).toBe(1);
  });

  it("propagates an error from any RPC call rather than swallowing it -- the Worker's own scheduled() handler is responsible for catching/logging, not this function", async () => {
    const repo = makeRepo({
      advanceOverdueSubscriptions: vi.fn(async () => {
        throw new Error("db unavailable");
      }),
    });
    const { logger } = makeLogger();

    await expect(runBillingLifecycle({ billingRepo: repo, logger })).rejects.toThrow(
      "db unavailable",
    );
  });

  it("never calls anything Razorpay- or email-related -- structurally impossible, no such dependency exists on BillingSchedulerRepository", async () => {
    // This Worker's deps type has exactly six methods, none of which touch
    // Razorpay or an email provider -- reconciliation of a real payment
    // still only ever happens via reconcile_razorpay_payment (apps/api's
    // webhook route), never from this scheduler.
    const repo = makeRepo();
    const { logger } = makeLogger();
    await expect(runBillingLifecycle({ billingRepo: repo, logger })).resolves.toEqual({
      invoicesGenerated: 0,
      subscriptionsAdvanced: 0,
      subscriptionsSuspended: 0,
      cancellationsFinalized: 0,
      remindersSent: 0,
      usageSummariesUpserted: 0,
    });
  });
});
