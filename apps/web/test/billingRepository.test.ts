import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  getBillingSubscription,
  listBillingInvoices,
  listBillingPayments,
} from "../lib/repositories/billingRepository.js";

interface QueryResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

interface FakeChain {
  calls: { method: string; args: unknown[] }[];
  select: (...args: unknown[]) => FakeChain;
  eq: (...args: unknown[]) => FakeChain;
  order: (...args: unknown[]) => FakeChain;
  limit: (...args: unknown[]) => FakeChain;
  maybeSingle: () => Promise<QueryResult>;
  then: (resolve: (value: QueryResult) => unknown) => unknown;
}

/** Minimal chainable + thenable stub matching Supabase's PostgrestFilterBuilder shape, same convention as leadsRepository.test.ts. */
function fakeChain(result: QueryResult): FakeChain {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): FakeChain => {
      calls.push({ method, args });
      return chain;
    };
  const chain: FakeChain = {
    calls,
    select: record("select"),
    eq: record("eq"),
    order: record("order"),
    limit: record("limit"),
    maybeSingle: async () => result,
    then: (resolve) => resolve(result),
  };
  return chain;
}

function fakeSupabaseClient(chain: FakeChain): SupabaseClient {
  return { from: () => chain } as unknown as SupabaseClient;
}

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";

describe("getBillingSubscription", () => {
  it("scopes the query to the given company_id, never a caller-supplied value beyond that", () => {
    const chain = fakeChain({ data: null, error: null });
    void getBillingSubscription(fakeSupabaseClient(chain), COMPANY_ID);
    expect(chain.calls).toContainEqual({ method: "eq", args: ["company_id", COMPANY_ID] });
  });

  it("returns null when the company has no subscription row yet", async () => {
    const chain = fakeChain({ data: null, error: null });
    const result = await getBillingSubscription(fakeSupabaseClient(chain), COMPANY_ID);
    expect(result).toBeNull();
  });

  it("flattens the nested plan_versions/plans join and normalizes the price to a number", async () => {
    const chain = fakeChain({
      data: {
        state: "active",
        current_period_start: "2026-08-01T00:00:00Z",
        current_period_end: "2026-08-31T00:00:00Z",
        grace_period_end: null,
        plan_versions: { monthly_price: "1999.00", currency: "INR", plans: { name: "Business" } },
      },
      error: null,
    });
    const result = await getBillingSubscription(fakeSupabaseClient(chain), COMPANY_ID);
    expect(result).toEqual({
      state: "active",
      currentPeriodStart: "2026-08-01T00:00:00Z",
      currentPeriodEnd: "2026-08-31T00:00:00Z",
      gracePeriodEnd: null,
      plan: { name: "Business", monthlyPrice: 1999, currency: "INR" },
    });
  });

  it("Phase 6C: surfaces grace_period_end when the subscription is in grace_period", async () => {
    const chain = fakeChain({
      data: {
        state: "grace_period",
        current_period_start: "2026-08-01T00:00:00Z",
        current_period_end: "2026-08-31T00:00:00Z",
        grace_period_end: "2026-09-04T00:00:00Z",
        plan_versions: { monthly_price: "1999.00", currency: "INR", plans: { name: "Business" } },
      },
      error: null,
    });
    const result = await getBillingSubscription(fakeSupabaseClient(chain), COMPANY_ID);
    expect(result?.gracePeriodEnd).toBe("2026-09-04T00:00:00Z");
  });

  it("handles a Postgrest array-shaped join (plan_versions/plans as arrays) the same way", async () => {
    const chain = fakeChain({
      data: {
        state: "trial",
        current_period_start: null,
        current_period_end: null,
        plan_versions: [{ monthly_price: 999, currency: "INR", plans: [{ name: "Starter" }] }],
      },
      error: null,
    });
    const result = await getBillingSubscription(fakeSupabaseClient(chain), COMPANY_ID);
    expect(result?.plan).toEqual({ name: "Starter", monthlyPrice: 999, currency: "INR" });
  });

  it("throws rather than silently swallowing a query error", async () => {
    const chain = fakeChain({ data: null, error: { code: "42501", message: "denied" } });
    await expect(getBillingSubscription(fakeSupabaseClient(chain), COMPANY_ID)).rejects.toEqual({
      code: "42501",
      message: "denied",
    });
  });
});

describe("listBillingInvoices", () => {
  it("scopes to company_id and maps every row, never leaking raw Postgrest field names", async () => {
    const chain = fakeChain({
      data: [
        {
          id: "inv-1",
          invoice_number: "INV-0001",
          status: "paid",
          total: "1999.00",
          currency: "INR",
          due_date: "2026-08-15",
          paid_date: "2026-08-10",
          created_at: "2026-08-01T00:00:00Z",
        },
      ],
      error: null,
    });
    const result = await listBillingInvoices(fakeSupabaseClient(chain), COMPANY_ID);
    expect(chain.calls).toContainEqual({ method: "eq", args: ["company_id", COMPANY_ID] });
    expect(result).toEqual([
      {
        id: "inv-1",
        invoiceNumber: "INV-0001",
        status: "paid",
        total: 1999,
        currency: "INR",
        dueDate: "2026-08-15",
        paidDate: "2026-08-10",
        createdAt: "2026-08-01T00:00:00Z",
      },
    ]);
  });

  it("returns an empty array, never null/undefined, when there are no invoices yet", async () => {
    const chain = fakeChain({ data: null, error: null });
    const result = await listBillingInvoices(fakeSupabaseClient(chain), COMPANY_ID);
    expect(result).toEqual([]);
  });
});

describe("listBillingPayments", () => {
  it("scopes to company_id and maps every row", async () => {
    const chain = fakeChain({
      data: [
        {
          id: "pay-1",
          method: "manual_bank_transfer",
          status: "pending",
          amount: "1999.00",
          currency: "INR",
          submitted_by_user_id: "user-1",
          approved_by_user_id: null,
          created_at: "2026-08-01T00:00:00Z",
        },
      ],
      error: null,
    });
    const result = await listBillingPayments(fakeSupabaseClient(chain), COMPANY_ID);
    expect(chain.calls).toContainEqual({ method: "eq", args: ["company_id", COMPANY_ID] });
    expect(result).toEqual([
      {
        id: "pay-1",
        method: "manual_bank_transfer",
        status: "pending",
        amount: 1999,
        currency: "INR",
        submittedByUserId: "user-1",
        approvedByUserId: null,
        createdAt: "2026-08-01T00:00:00Z",
      },
    ]);
  });

  it("returns an empty array when there are no payments yet", async () => {
    const chain = fakeChain({ data: null, error: null });
    const result = await listBillingPayments(fakeSupabaseClient(chain), COMPANY_ID);
    expect(result).toEqual([]);
  });
});
