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

/**
 * Phase 3A.1: searchConversations/searchLeads now resolve matching ids via
 * the search_company_conversations/search_company_leads RPCs (migration
 * 25), then fetch/display phone via get_conversation_phone_displays/
 * get_lead_phone_displays -- never a raw `contacts` table query or a
 * client-side ilike on whatsapp_wa_id/phone_number.
 */
function fakeSupabaseClient(
  chainsByTable: Record<string, FakeChain>,
  rpcResponses: Record<string, { data: unknown; error: { message: string } | null }> = {},
): SupabaseClient {
  return {
    from: vi.fn((table: string) => chainsByTable[table]),
    rpc: vi.fn((name: string) => {
      const response = rpcResponses[name] ?? { data: [], error: null };
      return Promise.resolve(response) as unknown as ReturnType<SupabaseClient["rpc"]>;
    }),
  } as unknown as SupabaseClient;
}

describe("searchConversations", () => {
  it("resolves matching conversation ids via search_company_conversations, scoped to the caller's own companyId", async () => {
    const conversationsChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient(
      { conversations: conversationsChain },
      { search_company_conversations: { data: [], error: null } },
    );

    await searchConversations(client, "company-a", "priya");

    expect(client.rpc).toHaveBeenCalledWith(
      "search_company_conversations",
      expect.objectContaining({ p_company_id: "company-a", p_term: "priya" }),
    );
  });

  it("never queries conversations at all when the search RPC finds no matches -- no cross-tenant leak via an empty/wide filter", async () => {
    const conversationsChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient(
      { conversations: conversationsChain },
      { search_company_conversations: { data: [], error: null } },
    );

    const results = await searchConversations(client, "company-a", "nobody");

    expect(results).toEqual([]);
    expect(conversationsChain.calls).toHaveLength(0);
  });

  it("fetches only the conversation ids the search RPC returned (never an arbitrary contact_id filter)", async () => {
    const conversationsChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient(
      { conversations: conversationsChain },
      {
        search_company_conversations: {
          data: [{ conversation_id: "conv-1" }, { conversation_id: "conv-2" }],
          error: null,
        },
      },
    );

    await searchConversations(client, "company-a", "priya");

    expect(conversationsChain.calls).toContainEqual({
      method: "in",
      args: ["id", ["conv-1", "conv-2"]],
    });
  });

  it("caps results at GLOBAL_SEARCH_RESULT_LIMIT", async () => {
    const conversationsChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient(
      { conversations: conversationsChain },
      { search_company_conversations: { data: [{ conversation_id: "conv-1" }], error: null } },
    );

    await searchConversations(client, "company-a", "priya");

    expect(GLOBAL_SEARCH_RESULT_LIMIT).toBe(5);
    expect(conversationsChain.calls).toContainEqual({
      method: "limit",
      args: [GLOBAL_SEARCH_RESULT_LIMIT],
    });
  });

  it("never selects contacts.whatsapp_wa_id directly -- phone display comes from get_conversation_phone_displays", async () => {
    const conversationsChain = fakeChain({
      data: [
        {
          id: "conv-1",
          contacts: { display_name: "Priya", profile_name: "Priya N" },
          messages: [{ body: "Hello there", channel_type: "text" }],
        },
      ],
      error: null,
    });
    const client = fakeSupabaseClient(
      { conversations: conversationsChain },
      {
        search_company_conversations: { data: [{ conversation_id: "conv-1" }], error: null },
        get_conversation_phone_displays: {
          data: [
            {
              conversation_id: "conv-1",
              phone_display: "********5678",
              phone_visibility: "masked",
            },
          ],
          error: null,
        },
      },
    );

    const results = await searchConversations(client, "company-a", "priya");

    const selectCall = conversationsChain.calls.find((c) => c.method === "select");
    expect(String(selectCall?.args[0])).not.toContain("whatsapp_wa_id");
    expect(results).toEqual([
      {
        conversationId: "conv-1",
        displayName: "Priya",
        maskedPhoneNumber: "********5678",
        phoneVisibility: "masked",
        latestMessagePreview: "Hello there",
      },
    ]);
  });

  it("shows a generic 'Voice message' preview for an audio message rather than its raw body", async () => {
    const conversationsChain = fakeChain({
      data: [
        {
          id: "conv-1",
          contacts: { display_name: "Priya", profile_name: null },
          messages: [{ body: null, channel_type: "audio" }],
        },
      ],
      error: null,
    });
    const client = fakeSupabaseClient(
      { conversations: conversationsChain },
      {
        search_company_conversations: { data: [{ conversation_id: "conv-1" }], error: null },
        get_conversation_phone_displays: {
          data: [
            {
              conversation_id: "conv-1",
              phone_display: "********5678",
              phone_visibility: "masked",
            },
          ],
          error: null,
        },
      },
    );

    const [result] = await searchConversations(client, "company-a", "priya");
    expect(result?.latestMessagePreview).toBe("Voice message");
  });
});

describe("searchLeads", () => {
  it("resolves matching lead ids via search_company_leads, scoped to the caller's own companyId", async () => {
    const chain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient(
      { leads: chain },
      { search_company_leads: { data: [], error: null } },
    );

    await searchLeads(client, "company-a", "priya");

    expect(client.rpc).toHaveBeenCalledWith(
      "search_company_leads",
      expect.objectContaining({ p_company_id: "company-a", p_term: "priya" }),
    );
  });

  it("never queries leads at all when the search RPC finds no matches", async () => {
    const chain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient(
      { leads: chain },
      { search_company_leads: { data: [], error: null } },
    );

    const results = await searchLeads(client, "company-a", "nobody");
    expect(results).toEqual([]);
    expect(chain.calls).toHaveLength(0);
  });

  it("caps results at GLOBAL_SEARCH_RESULT_LIMIT", async () => {
    const chain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient(
      { leads: chain },
      { search_company_leads: { data: [{ lead_id: "lead-1" }], error: null } },
    );

    await searchLeads(client, "company-a", "priya");

    expect(chain.calls).toContainEqual({ method: "limit", args: [GLOBAL_SEARCH_RESULT_LIMIT] });
  });

  it("resolves a real identity for the result via the secure phone RPC, never 'Unknown lead' and never a raw column select", async () => {
    const chain = fakeChain({
      data: [
        {
          id: "lead-1",
          customer_name: null,
          company_name: null,
          service_interest: "Website",
          stage: "new",
          contacts: { display_name: null, profile_name: null },
        },
      ],
      error: null,
    });
    const client = fakeSupabaseClient(
      { leads: chain },
      {
        search_company_leads: { data: [{ lead_id: "lead-1" }], error: null },
        get_lead_phone_displays: {
          data: [{ lead_id: "lead-1", phone_display: "********5678", phone_visibility: "masked" }],
          error: null,
        },
      },
    );

    const [result] = await searchLeads(client, "company-a", "9812");
    const selectCall = chain.calls.find((c) => c.method === "select");
    expect(String(selectCall?.args[0])).not.toContain("whatsapp_wa_id");
    expect(result?.displayName).toBe("********5678");
    expect(result?.displayName).not.toBe("Unknown lead");
  });

  it("propagates a genuine database error rather than silently swallowing it (P1 stabilization regression)", async () => {
    const chain = fakeChain({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });
    const client = fakeSupabaseClient(
      { leads: chain },
      { search_company_leads: { data: [{ lead_id: "lead-1" }], error: null } },
    );

    await expect(searchLeads(client, "company-a", "priya")).rejects.toThrow("too many connections");
  });
});
