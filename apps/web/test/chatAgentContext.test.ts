import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConversationThreadMessage } from "@dravonix/handover";
import { describe, expect, it, vi } from "vitest";
import { loadChatAgentContext } from "../lib/repositories/chatAgentContext.js";

interface QueryResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

interface FakeChain {
  calls: { method: string; args: unknown[] }[];
  select: (...args: unknown[]) => FakeChain;
  eq: (...args: unknown[]) => FakeChain;
  single: (...args: unknown[]) => FakeChain;
  maybeSingle: (...args: unknown[]) => FakeChain;
  then: (resolve: (value: QueryResult) => unknown) => unknown;
}

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
    single: record("single"),
    maybeSingle: record("maybeSingle"),
    then: (resolve) => resolve(result),
  };
  return chain;
}

interface RpcPhoneRow {
  conversation_id?: string;
  lead_id?: string;
  phone_display: string;
  phone_visibility: "full" | "masked";
}

/**
 * Phase 3A security correction: loadChatAgentContext no longer selects
 * contacts.whatsapp_wa_id or leads.phone_number as raw columns -- both are
 * resolved via get_conversation_phone_displays/get_lead_phone_displays
 * (migration 25), same as every other client-facing read path, then forced
 * through an unconditional second mask. `conversationPhone`/`leadPhones`
 * are the RPCs' canned responses for this test.
 */
function fakeSupabaseClient(
  chainsByTable: Record<string, FakeChain>,
  rpc: { conversationPhone?: RpcPhoneRow[]; leadPhones?: RpcPhoneRow[] } = {},
): SupabaseClient {
  return {
    from: vi.fn((table: string) => chainsByTable[table]),
    rpc: vi.fn((name: string) => {
      if (name === "get_conversation_phone_displays") {
        return Promise.resolve({ data: rpc.conversationPhone ?? [], error: null });
      }
      if (name === "get_lead_phone_displays") {
        return Promise.resolve({ data: rpc.leadPhones ?? [], error: null });
      }
      throw new Error(`Unexpected RPC call: ${name}`);
    }) as unknown as SupabaseClient["rpc"],
  } as unknown as SupabaseClient;
}

const COMPANY_ID = "company-1";
const CONVERSATION_ID = "conv-1";
const LEAD_ID = "lead-1";

function threadMessage(
  overrides: Partial<ConversationThreadMessage> = {},
): ConversationThreadMessage {
  return {
    id: "msg-1",
    direction: "inbound",
    channelType: "text",
    senderType: "customer",
    senderMemberId: null,
    body: "Hello",
    outboundStatus: null,
    providerMessageId: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function defaultChains(overrides: Partial<Record<string, FakeChain>> = {}) {
  return {
    companies: fakeChain({ data: { name: "Dravonix Media" }, error: null }),
    company_settings: fakeChain({
      data: {
        tone: "friendly_professional",
        enabled_languages: ["en", "ml"],
        fallback_language: "en",
        restricted_topics: [],
      },
      error: null,
    }),
    conversations: fakeChain({ data: null, error: null }),
    leads: fakeChain({ data: null, error: null }),
    ...overrides,
  };
}

describe("loadChatAgentContext: tenant scoping", () => {
  it("scopes every query to the caller's own companyId, never a different value", async () => {
    const chains = defaultChains();
    const client = fakeSupabaseClient(chains);

    await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    for (const table of ["companies", "company_settings", "conversations", "leads"] as const) {
      const eqCalls = chains[table].calls.filter((c) => c.method === "eq");
      const companyIdCall = eqCalls.find(
        (c) => c.args[0] === "company_id" || (table === "companies" && c.args[0] === "id"),
      );
      expect(companyIdCall?.args[1]).toBe(COMPANY_ID);
    }
  });

  it("scopes the contact and lead queries to the specific conversationId", async () => {
    const chains = defaultChains();
    const client = fakeSupabaseClient(chains);

    await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    expect(chains.conversations.calls).toContainEqual({
      method: "eq",
      args: ["id", CONVERSATION_ID],
    });
    expect(chains.leads.calls).toContainEqual({
      method: "eq",
      args: ["conversation_id", CONVERSATION_ID],
    });
  });

  it("only ever reads (select) -- never inserts, updates, or deletes anything", async () => {
    const chains = defaultChains();
    const client = fakeSupabaseClient(chains) as unknown as { from: ReturnType<typeof vi.fn> };
    await loadChatAgentContext(
      client as unknown as SupabaseClient,
      COMPANY_ID,
      CONVERSATION_ID,
      [],
    );

    for (const chain of Object.values(chains)) {
      const methods = chain.calls.map((c) => c.method);
      expect(methods).not.toContain("insert");
      expect(methods).not.toContain("update");
      expect(methods).not.toContain("delete");
      expect(methods).not.toContain("upsert");
    }
  });

  it("never selects contacts.whatsapp_wa_id or leads.phone_number as a raw column", async () => {
    const chains = defaultChains();
    const client = fakeSupabaseClient(chains);

    await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    const conversationsSelect = chains.conversations.calls.find((c) => c.method === "select");
    const leadsSelect = chains.leads.calls.find((c) => c.method === "select");
    expect(String(conversationsSelect?.args[0])).not.toContain("whatsapp_wa_id");
    expect(String(leadsSelect?.args[0])).not.toContain("phone_number");
  });
});

describe("loadChatAgentContext: company AI configuration", () => {
  it("uses only the approved company_settings fields, defaulting safely when no row exists", async () => {
    const chains = defaultChains({ company_settings: fakeChain({ data: null, error: null }) });
    const client = fakeSupabaseClient(chains);

    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    expect(context.company).toEqual({
      companyName: "Dravonix Media",
      tone: "friendly_professional",
      enabledLanguages: ["en"],
      fallbackLanguage: "en",
      restrictedTopics: [],
    });
  });

  it("passes through real company_settings values when present", async () => {
    const chains = defaultChains();
    const client = fakeSupabaseClient(chains);

    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    expect(context.company.tone).toBe("friendly_professional");
    expect(context.company.enabledLanguages).toEqual(["en", "ml"]);
  });
});

describe("loadChatAgentContext: contact and lead", () => {
  it("returns null contact/lead when no rows exist, never fabricating a value", async () => {
    const chains = defaultChains();
    const client = fakeSupabaseClient(chains);

    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    expect(context.contact).toBeNull();
    expect(context.lead).toBeNull();
  });

  it("masks the phone number in the returned contact context when the RPC reports it already masked", async () => {
    const chains = defaultChains({
      conversations: fakeChain({
        data: {
          contacts: {
            display_name: "Anjali",
            profile_name: null,
            last_detected_language: "ml",
          },
        },
        error: null,
      }),
    });
    const client = fakeSupabaseClient(chains, {
      conversationPhone: [
        {
          conversation_id: CONVERSATION_ID,
          phone_display: "********0001",
          phone_visibility: "masked",
        },
      ],
    });

    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    expect(context.contact?.displayName).toBe("Anjali");
    expect(context.contact?.maskedPhoneNumber).not.toBe("919820000001");
    expect(context.contact?.maskedPhoneNumber).toMatch(/\*/);
  });

  it("Phase 3A: forces the mask itself when the RPC grants the caller full visibility -- the raw digits never reach the prompt", async () => {
    const chains = defaultChains({
      conversations: fakeChain({
        data: {
          contacts: {
            display_name: "Anjali",
            profile_name: null,
            last_detected_language: "ml",
          },
        },
        error: null,
      }),
    });
    const client = fakeSupabaseClient(chains, {
      conversationPhone: [
        {
          conversation_id: CONVERSATION_ID,
          phone_display: "919820000001",
          phone_visibility: "full",
        },
      ],
    });

    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    expect(context.contact?.maskedPhoneNumber).not.toBe("919820000001");
    expect(context.contact?.maskedPhoneNumber).not.toContain("919820000001");
    expect(context.contact?.maskedPhoneNumber).toMatch(/\*/);
    expect(context.contact?.maskedPhoneNumber).toBe("********0001");
  });

  it("returns existing lead fields read-only, using the real column values", async () => {
    const chains = defaultChains({
      leads: fakeChain({
        data: {
          id: LEAD_ID,
          customer_name: "Anjali",
          company_name: null,
          email: null,
          service_interest: "Website redesign",
          budget: null,
          preferred_timeline: null,
          location: null,
          notes: null,
        },
        error: null,
      }),
    });
    const client = fakeSupabaseClient(chains, { leadPhones: [] });

    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    expect(context.lead).toEqual({
      customerName: "Anjali",
      companyName: null,
      phone: null,
      email: null,
      serviceInterest: "Website redesign",
      budget: null,
      timeline: null,
      location: null,
      notes: null,
    });
  });

  it("Phase 3A.1: masks the lead's own phone before it ever enters the DRAIVA context/prompt, regardless of the caller's own phone-visibility permission", async () => {
    const chains = defaultChains({
      leads: fakeChain({
        data: {
          id: LEAD_ID,
          customer_name: "Anjali",
          company_name: null,
          email: null,
          service_interest: "Website redesign",
          budget: null,
          preferred_timeline: null,
          location: null,
          notes: null,
        },
        error: null,
      }),
    });
    const client = fakeSupabaseClient(chains, {
      leadPhones: [{ lead_id: LEAD_ID, phone_display: "919820000001", phone_visibility: "full" }],
    });

    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, []);

    expect(context.lead?.phone).not.toBe("919820000001");
    expect(context.lead?.phone).not.toContain("919820000001");
    expect(context.lead?.phone).toMatch(/\*/);
  });
});

describe("loadChatAgentContext: history bounding and message filtering", () => {
  it("drops messages with no transcribable body instead of sending an empty string to the model", async () => {
    const chains = defaultChains();
    const client = fakeSupabaseClient(chains);
    const messages = [
      threadMessage({ id: "1", body: "Hi", createdAt: "t1" }),
      threadMessage({ id: "2", body: null, createdAt: "t2" }),
      threadMessage({ id: "3", body: "  ", createdAt: "t3" }),
      threadMessage({ id: "4", body: "How much?", createdAt: "t4" }),
    ];

    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, messages);

    expect(context.messages.map((m) => m.body)).toEqual(["Hi", "How much?"]);
  });

  it("only ever bounds the single conversation's own thread -- never a second conversation's messages", async () => {
    const chains = defaultChains();
    const client = fakeSupabaseClient(chains);
    const messages = [threadMessage({ id: "1", body: "Only this conversation", createdAt: "t1" })];

    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, messages);

    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.body).toBe("Only this conversation");
  });

  it("reports historyTruncated=false for a short conversation", async () => {
    const chains = defaultChains();
    const client = fakeSupabaseClient(chains);
    const context = await loadChatAgentContext(client, COMPANY_ID, CONVERSATION_ID, [
      threadMessage({ body: "Hi" }),
    ]);
    expect(context.historyTruncated).toBe(false);
  });
});
