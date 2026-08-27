import { describe, expect, it } from "vitest";
import {
  computeUsageSummaryUpserts,
  type RawUsageEvent,
  type SubscriptionPeriod,
} from "../src/usageAggregation.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";

const periodA: SubscriptionPeriod = {
  companyId: COMPANY_A,
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-02-01T00:00:00.000Z",
};
const periodB: SubscriptionPeriod = {
  companyId: COMPANY_B,
  periodStart: "2026-01-15T00:00:00.000Z",
  periodEnd: "2026-02-15T00:00:00.000Z",
};

describe("computeUsageSummaryUpserts", () => {
  it("sums multiple events for two companies into distinct, correctly attributed summary rows", async () => {
    const events: RawUsageEvent[] = [
      {
        companyId: COMPANY_A,
        metric: "whatsapp_outbound_messages",
        quantity: 3,
        isBillable: true,
        occurredAt: "2026-01-10T00:00:00.000Z",
      },
      {
        companyId: COMPANY_A,
        metric: "whatsapp_outbound_messages",
        quantity: 2,
        isBillable: true,
        occurredAt: "2026-01-20T00:00:00.000Z",
      },
      {
        companyId: COMPANY_A,
        metric: "claude_input_tokens",
        quantity: 500,
        isBillable: true,
        occurredAt: "2026-01-10T00:00:00.000Z",
      },
      {
        companyId: COMPANY_B,
        metric: "whatsapp_outbound_messages",
        quantity: 7,
        isBillable: true,
        occurredAt: "2026-01-20T00:00:00.000Z",
      },
    ];

    const result = computeUsageSummaryUpserts([periodA, periodB], events);

    const companyAMessages = result.find(
      (r) => r.companyId === COMPANY_A && r.metric === "whatsapp_outbound_messages",
    );
    expect(companyAMessages?.totalQuantity).toBe(5);
    expect(companyAMessages?.periodStart).toBe("2026-01-01");
    expect(companyAMessages?.periodEnd).toBe("2026-02-01");

    const companyATokens = result.find(
      (r) => r.companyId === COMPANY_A && r.metric === "claude_input_tokens",
    );
    expect(companyATokens?.totalQuantity).toBe(500);

    const companyBMessages = result.find(
      (r) => r.companyId === COMPANY_B && r.metric === "whatsapp_outbound_messages",
    );
    expect(companyBMessages?.totalQuantity).toBe(7);
    expect(companyBMessages?.periodStart).toBe("2026-01-15");

    expect(result).toHaveLength(3);
  });

  it("excludes an event outside its company's current period (half-open interval)", () => {
    const events: RawUsageEvent[] = [
      {
        companyId: COMPANY_A,
        metric: "whatsapp_outbound_messages",
        quantity: 1,
        isBillable: true,
        occurredAt: "2025-12-31T23:59:59.000Z", // before periodStart
      },
      {
        companyId: COMPANY_A,
        metric: "whatsapp_outbound_messages",
        quantity: 1,
        isBillable: true,
        occurredAt: "2026-02-01T00:00:00.000Z", // exactly at periodEnd -- belongs to the NEXT period
      },
    ];

    const result = computeUsageSummaryUpserts([periodA], events);

    expect(result).toHaveLength(0);
  });

  it("excludes an event belonging to a different company entirely", () => {
    const events: RawUsageEvent[] = [
      {
        companyId: "some-other-company",
        metric: "whatsapp_outbound_messages",
        quantity: 100,
        isBillable: true,
        occurredAt: "2026-01-10T00:00:00.000Z",
      },
    ];

    const result = computeUsageSummaryUpserts([periodA], events);

    expect(result).toHaveLength(0);
  });

  it("separates billable_quantity from total_quantity", () => {
    const events: RawUsageEvent[] = [
      {
        companyId: COMPANY_A,
        metric: "claude_requests",
        quantity: 1,
        isBillable: true,
        occurredAt: "2026-01-10T00:00:00.000Z",
      },
      {
        companyId: COMPANY_A,
        metric: "claude_requests",
        quantity: 1,
        isBillable: false,
        occurredAt: "2026-01-11T00:00:00.000Z",
      },
    ];

    const result = computeUsageSummaryUpserts([periodA], events);

    expect(result).toHaveLength(1);
    expect(result[0]?.totalQuantity).toBe(2);
    expect(result[0]?.billableQuantity).toBe(1);
  });

  it("produces no row for a metric with zero events in the period -- callers treat absence as zero", () => {
    const result = computeUsageSummaryUpserts([periodA], []);
    expect(result).toHaveLength(0);
  });

  it("is idempotent: recomputing from the exact same raw events yields the exact same totals every time", () => {
    const events: RawUsageEvent[] = [
      {
        companyId: COMPANY_A,
        metric: "whatsapp_outbound_messages",
        quantity: 4,
        isBillable: true,
        occurredAt: "2026-01-10T00:00:00.000Z",
      },
    ];

    const first = computeUsageSummaryUpserts([periodA], events);
    const second = computeUsageSummaryUpserts([periodA], events);

    expect(second).toEqual(first);
  });

  it("naturally incorporates late-arriving usage on the next recompute rather than needing separate reconciliation", () => {
    const initialEvents: RawUsageEvent[] = [
      {
        companyId: COMPANY_A,
        metric: "whatsapp_outbound_messages",
        quantity: 1,
        isBillable: true,
        occurredAt: "2026-01-10T00:00:00.000Z",
      },
    ];
    const firstRun = computeUsageSummaryUpserts([periodA], initialEvents);
    expect(firstRun[0]?.totalQuantity).toBe(1);

    // A usage event recorded slightly late (e.g. a retried job) shows up in
    // the raw table before the next scheduler run.
    const withLateEvent: RawUsageEvent[] = [
      ...initialEvents,
      {
        companyId: COMPANY_A,
        metric: "whatsapp_outbound_messages",
        quantity: 1,
        isBillable: true,
        occurredAt: "2026-01-11T00:00:00.000Z",
      },
    ];
    const secondRun = computeUsageSummaryUpserts([periodA], withLateEvent);
    expect(secondRun[0]?.totalQuantity).toBe(2); // replaces, not adds to, the prior summary
  });
});
