import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  GLOBAL_SEARCH_RESULT_LIMIT,
  searchConversations,
  searchLeads,
} from "../lib/repositories/globalSearchRepository.js";

interface QueryResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

interface FakeChain {
  calls: { method: string; args: unknown[] }[];
  select: (...args: unknown[]) => FakeChain;
  eq: (...args: unknown[]) => FakeChain;
  or: (...args: unknown[]) => FakeChain;
  in: (...args: unknown[]) => FakeChain;
  order: (...args: unknown[]) => FakeChain;
  limit: (...args: unknown[]) => FakeChain;
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
    in: record("in"),
    order: record("order"),
    limit: record("limit"),
    then: (resolve) => resolve(result),
  };
  return chain;
}

/** Two queues, one per table, so contacts and conversations/leads return different fixtures within the same test. */
function fakeSupabaseClient(chainsByTable: Record<string, FakeChain>): SupabaseClient {
  return {
    from: vi.fn((table: string) => chainsByTable[table]),
  } as unknown as SupabaseClient;
}

describe("searchConversations", () => {
  it("scopes both the contacts lookup and the conversations query to the caller's own companyId", async () => {
    const contactsChain = fakeChain({ data: [{ id: "contact-1" }], error: null });
    const conversationsChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({
      contacts: contactsChain,
      conversations: conversationsChain,
    });

    await searchConversations(client, "company-a", "priya");

    expect(contactsChain.calls).toContainEqual({ method: "eq", args: ["company_id", "company-a"] });
    expect(conversationsChain.calls).toContainEqual({
      method: "eq",
      args: ["company_id", "company-a"],
    });
  });

  it("never queries conversations at all when no contact matches -- no cross-tenant leak via an empty/wide contact_id filter", async () => {
    const contactsChain = fakeChain({ data: [], error: null });
    const conversationsChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({
      contacts: contactsChain,
      conversations: conversationsChain,
    });

    const results = await searchConversations(client, "company-a", "nobody");

    expect(results).toEqual([]);
    expect(conversationsChain.calls).toHaveLength(0);
  });

  it("only searches conversations belonging to contacts already scoped to this company (never an arbitrary contact_id)", async () => {
    const contactsChain = fakeChain({
      data: [{ id: "contact-1" }, { id: "contact-2" }],
      error: null,
    });
    const conversationsChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({
      contacts: contactsChain,
      conversations: conversationsChain,
    });

    await searchConversations(client, "company-a", "priya");

    expect(conversationsChain.calls).toContainEqual({
      method: "in",
      args: ["contact_id", ["contact-1", "contact-2"]],
    });
  });

  it("caps results at GLOBAL_SEARCH_RESULT_LIMIT", async () => {
    const contactsChain = fakeChain({ data: [{ id: "contact-1" }], error: null });
    const conversationsChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({
      contacts: contactsChain,
      conversations: conversationsChain,
    });

    await searchConversations(client, "company-a", "priya");

    expect(GLOBAL_SEARCH_RESULT_LIMIT).toBe(5);
    expect(conversationsChain.calls).toContainEqual({
      method: "limit",
      args: [GLOBAL_SEARCH_RESULT_LIMIT],
    });
  });

  it("maps a matched row into the result shape, preferring the contact's display_name", async () => {
    const contactsChain = fakeChain({ data: [{ id: "contact-1" }], error: null });
    const conversationsChain = fakeChain({
      data: [
        {
          id: "conv-1",
          contacts: {
            whatsapp_wa_id: "+919812345678",
            display_name: "Priya",
            profile_name: "Priya N",
          },
          messages: [{ body: "Hello there", channel_type: "text" }],
        },
      ],
      error: null,
    });
    const client = fakeSupabaseClient({
      contacts: contactsChain,
      conversations: conversationsChain,
    });

    const results = await searchConversations(client, "company-a", "priya");

    expect(results).toEqual([
      {
        conversationId: "conv-1",
        displayName: "Priya",
        maskedPhoneNumber: "********5678",
        latestMessagePreview: "Hello there",
      },
    ]);
  });

  it("shows a generic 'Voice message' preview for an audio message rather than its raw body", async () => {
    const contactsChain = fakeChain({ data: [{ id: "contact-1" }], error: null });
    const conversationsChain = fakeChain({
      data: [
        {
          id: "conv-1",
          contacts: { whatsapp_wa_id: "+919812345678", display_name: "Priya", profile_name: null },
          messages: [{ body: null, channel_type: "audio" }],
        },
      ],
      error: null,
    });
    const client = fakeSupabaseClient({
      contacts: contactsChain,
      conversations: conversationsChain,
    });

    const [result] = await searchConversations(client, "company-a", "priya");
    expect(result?.latestMessagePreview).toBe("Voice message");
  });
});

describe("searchLeads", () => {
  it("scopes the query to the caller's own companyId", async () => {
    const chain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({ leads: chain });

    await searchLeads(client, "company-a", "priya");

    expect(chain.calls).toContainEqual({ method: "eq", args: ["company_id", "company-a"] });
  });

  it("caps results at GLOBAL_SEARCH_RESULT_LIMIT", async () => {
    const chain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({ leads: chain });

    await searchLeads(client, "company-a", "priya");

    expect(chain.calls).toContainEqual({ method: "limit", args: [GLOBAL_SEARCH_RESULT_LIMIT] });
  });

  it("resolves a real identity for the result, never 'Unknown lead'", async () => {
    const chain = fakeChain({
      data: [
        {
          id: "lead-1",
          customer_name: null,
          company_name: null,
          service_interest: "Website",
          stage: "new",
          contacts: { whatsapp_wa_id: "+919812345678", display_name: null, profile_name: null },
        },
      ],
      error: null,
    });
    const client = fakeSupabaseClient({ leads: chain });

    const [result] = await searchLeads(client, "company-a", "9812");
    expect(result?.displayName).toBe("********5678");
    expect(result?.displayName).not.toBe("Unknown lead");
  });
});
