import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { getLead, listLeadEvents, listLeads } from "../lib/repositories/leadsRepository.js";

interface QueryResult {
  data: unknown;
  count?: number | null;
  error: { code: string; message: string } | null;
}

interface FakeChain {
  calls: { method: string; args: unknown[] }[];
  select: (...args: unknown[]) => FakeChain;
  eq: (...args: unknown[]) => FakeChain;
  or: (...args: unknown[]) => FakeChain;
  is: (...args: unknown[]) => FakeChain;
  order: (...args: unknown[]) => FakeChain;
  range: (...args: unknown[]) => FakeChain;
  maybeSingle: () => Promise<QueryResult>;
  then: (resolve: (value: QueryResult) => unknown) => unknown;
}

/** Minimal chainable + thenable stub matching Supabase's PostgrestFilterBuilder shape. */
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
    or: record("or"),
    is: record("is"),
    order: record("order"),
    range: record("range"),
    maybeSingle: async () => result,
    then: (resolve) => resolve(result),
  };
  return chain;
}

function fakeSupabaseClient(chain: ReturnType<typeof fakeChain>): SupabaseClient {
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

const LEAD_ROW = {
  id: "lead-1",
  company_id: "company-a",
  customer_name: "Priya Nair",
  company_name: "Priya Clinic",
  phone_number: "+919812345678",
  service_interest: "Website",
  product_interest: "E-commerce",
  budget: "50000",
  preferred_timeline: "1 month",
  email: "priya@example.com",
  location: "Kochi",
  branch: "South",
  notes: "Called back once",
  source: "whatsapp_chatbot",
  score: 80,
  stage: "qualifying",
  assigned_member_id: "member-1",
  conversation_id: "conv-1",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  contacts: { whatsapp_wa_id: "+919812345678", display_name: "Priya", profile_name: "Priya N" },
};

describe("listLeads", () => {
  it("always scopes the query to the caller's own companyId", async () => {
    const chain = fakeChain({ data: [LEAD_ROW], count: 1, error: null });
    const client = fakeSupabaseClient(chain);

    await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      page: 1,
      pageSize: 25,
    });

    const eqCalls = chain.calls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["company_id", "company-a"] });
  });

  it("maps rows into the list-item shape, masking the phone number", async () => {
    const chain = fakeChain({ data: [LEAD_ROW], count: 1, error: null });
    const client = fakeSupabaseClient(chain);

    const { items, totalCount } = await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      page: 1,
      pageSize: 25,
    });

    expect(totalCount).toBe(1);
    expect(items).toEqual([
      {
        id: "lead-1",
        customerName: "Priya Nair",
        displayName: "Priya Nair",
        companyName: "Priya Clinic",
        maskedPhoneNumber: "********5678",
        serviceInterest: "Website",
        stage: "qualifying",
        score: 80,
        assignedMemberId: "member-1",
        conversationId: "conv-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("selects the joined contacts columns needed for identity fallback", async () => {
    const chain = fakeChain({ data: [], count: 0, error: null });
    const client = fakeSupabaseClient(chain);

    await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      page: 1,
      pageSize: 25,
    });

    const selectCall = chain.calls.find((c) => c.method === "select");
    expect(String(selectCall?.args[0])).toContain(
      "contacts (whatsapp_wa_id, display_name, profile_name)",
    );
  });

  it("filters by stage when a specific stage is requested", async () => {
    const chain = fakeChain({ data: [], count: 0, error: null });
    const client = fakeSupabaseClient(chain);

    await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      stage: "qualified",
      page: 1,
      pageSize: 25,
    });

    expect(chain.calls).toContainEqual({ method: "eq", args: ["stage", "qualified"] });
  });

  it("does not filter by stage when 'all' is requested", async () => {
    const chain = fakeChain({ data: [], count: 0, error: null });
    const client = fakeSupabaseClient(chain);

    await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      stage: "all",
      page: 1,
      pageSize: 25,
    });

    expect(chain.calls.some((c) => c.method === "eq" && c.args[0] === "stage")).toBe(false);
  });

  it("filters to the caller's own memberId when assignment is 'mine' -- never an arbitrary supplied member id", async () => {
    const chain = fakeChain({ data: [], count: 0, error: null });
    const client = fakeSupabaseClient(chain);

    await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      assignment: "mine",
      page: 1,
      pageSize: 25,
    });

    expect(chain.calls).toContainEqual({
      method: "eq",
      args: ["assigned_member_id", "member-1"],
    });
  });

  it("filters to unassigned leads when assignment is 'unassigned'", async () => {
    const chain = fakeChain({ data: [], count: 0, error: null });
    const client = fakeSupabaseClient(chain);

    await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      assignment: "unassigned",
      page: 1,
      pageSize: 25,
    });

    expect(chain.calls).toContainEqual({ method: "is", args: ["assigned_member_id", null] });
  });

  it("applies a search filter across name/company/phone/email when a search term is given", async () => {
    const chain = fakeChain({ data: [], count: 0, error: null });
    const client = fakeSupabaseClient(chain);

    await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      search: "priya",
      page: 1,
      pageSize: 25,
    });

    const orCall = chain.calls.find((c) => c.method === "or");
    expect(orCall).toBeDefined();
    expect(String(orCall?.args[0])).toContain("priya");
  });

  it("paginates using range derived from page/pageSize", async () => {
    const chain = fakeChain({ data: [], count: 0, error: null });
    const client = fakeSupabaseClient(chain);

    await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      page: 2,
      pageSize: 10,
    });

    expect(chain.calls).toContainEqual({ method: "range", args: [10, 19] });
  });

  it("propagates a genuine database error rather than silently swallowing it", async () => {
    const chain = fakeChain({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });
    const client = fakeSupabaseClient(chain);

    await expect(
      listLeads(client, {
        companyId: "company-a",
        callerMemberId: "member-1",
        page: 1,
        pageSize: 25,
      }),
    ).rejects.toThrow("too many connections");
  });
});

describe("lead identity resolution (resolveLeadDisplayName via listLeads)", () => {
  async function firstDisplayName(row: Record<string, unknown>): Promise<string> {
    const chain = fakeChain({ data: [row], count: 1, error: null });
    const client = fakeSupabaseClient(chain);
    const { items } = await listLeads(client, {
      companyId: "company-a",
      callerMemberId: "member-1",
      page: 1,
      pageSize: 25,
    });
    return items[0]!.displayName;
  }

  it("prefers the AI-extracted customer_name when present", async () => {
    expect(await firstDisplayName(LEAD_ROW)).toBe("Priya Nair");
  });

  it("falls back to the contact's WhatsApp display_name when customer_name is not yet extracted", async () => {
    expect(await firstDisplayName({ ...LEAD_ROW, customer_name: null, company_name: null })).toBe(
      "Priya",
    );
  });

  it("falls back to the contact's profile_name when neither customer_name nor display_name exist", async () => {
    expect(
      await firstDisplayName({
        ...LEAD_ROW,
        customer_name: null,
        company_name: null,
        contacts: { ...LEAD_ROW.contacts, display_name: null },
      }),
    ).toBe("Priya N");
  });

  it("falls back to company_name when no personal contact name exists at all", async () => {
    expect(
      await firstDisplayName({
        ...LEAD_ROW,
        customer_name: null,
        contacts: { ...LEAD_ROW.contacts, display_name: null, profile_name: null },
      }),
    ).toBe("Priya Clinic");
  });

  it("falls back to the masked WhatsApp phone number when no name or company exists", async () => {
    expect(
      await firstDisplayName({
        ...LEAD_ROW,
        customer_name: null,
        company_name: null,
        contacts: { ...LEAD_ROW.contacts, display_name: null, profile_name: null },
      }),
    ).toBe("********5678");
  });

  it("falls back to the contact's whatsapp_wa_id (not leads.phone_number) when the lead's own phone_number was never extracted", async () => {
    expect(
      await firstDisplayName({
        ...LEAD_ROW,
        customer_name: null,
        company_name: null,
        phone_number: null,
        contacts: { whatsapp_wa_id: "+919999999999", display_name: null, profile_name: null },
      }),
    ).toBe("********9999");
  });

  it("never shows 'Unknown lead' -- the last-resort fallback is a neutral, non-fabricated label", async () => {
    expect(
      await firstDisplayName({
        ...LEAD_ROW,
        customer_name: null,
        company_name: null,
        phone_number: null,
        contacts: null,
      }),
    ).toBe("Unnamed WhatsApp lead");
    expect(
      await firstDisplayName({
        ...LEAD_ROW,
        customer_name: null,
        company_name: null,
        phone_number: null,
        contacts: null,
      }),
    ).not.toBe("Unknown lead");
  });
});

describe("getLead", () => {
  it("always scopes by both companyId and leadId", async () => {
    const chain = fakeChain({ data: LEAD_ROW, error: null });
    const client = fakeSupabaseClient(chain);

    await getLead(client, "company-a", "lead-1");

    expect(chain.calls).toContainEqual({ method: "eq", args: ["company_id", "company-a"] });
    expect(chain.calls).toContainEqual({ method: "eq", args: ["id", "lead-1"] });
  });

  it("returns null for a missing/cross-tenant/RLS-hidden lead, never distinguishing which", async () => {
    const chain = fakeChain({ data: null, error: null });
    const client = fakeSupabaseClient(chain);

    const result = await getLead(client, "company-a", "lead-does-not-exist");
    expect(result).toBeNull();
  });

  it("maps a found row into the full detail shape", async () => {
    const chain = fakeChain({ data: LEAD_ROW, error: null });
    const client = fakeSupabaseClient(chain);

    const result = await getLead(client, "company-a", "lead-1");
    expect(result).toEqual({
      id: "lead-1",
      companyId: "company-a",
      customerName: "Priya Nair",
      displayName: "Priya Nair",
      companyName: "Priya Clinic",
      maskedPhoneNumber: "********5678",
      serviceInterest: "Website",
      productInterest: "E-commerce",
      budget: "50000",
      preferredTimeline: "1 month",
      email: "priya@example.com",
      location: "Kochi",
      branch: "South",
      notes: "Called back once",
      source: "whatsapp_chatbot",
      score: 80,
      stage: "qualifying",
      assignedMemberId: "member-1",
      conversationId: "conv-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });
});

describe("listLeadEvents", () => {
  it("scopes by companyId and leadId, mapping rows to camelCase", async () => {
    const chain = fakeChain({
      data: [
        {
          id: "event-1",
          event_type: "stage_changed",
          event_data: { from: "new", to: "qualifying" },
          actor_member_id: "member-1",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const client = fakeSupabaseClient(chain);

    const events = await listLeadEvents(client, "company-a", "lead-1");

    expect(chain.calls).toContainEqual({ method: "eq", args: ["company_id", "company-a"] });
    expect(chain.calls).toContainEqual({ method: "eq", args: ["lead_id", "lead-1"] });
    expect(events).toEqual([
      {
        id: "event-1",
        eventType: "stage_changed",
        eventData: { from: "new", to: "qualifying" },
        actorMemberId: "member-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("returns an empty array when there are no events", async () => {
    const chain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient(chain);

    expect(await listLeadEvents(client, "company-a", "lead-1")).toEqual([]);
  });
});
