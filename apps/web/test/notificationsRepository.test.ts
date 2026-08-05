import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { loadNotificationSummary } from "../lib/repositories/notificationsRepository.js";

interface QueryResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

interface FakeChain {
  calls: { method: string; args: unknown[] }[];
  select: (...args: unknown[]) => FakeChain;
  eq: (...args: unknown[]) => FakeChain;
  neq: (...args: unknown[]) => FakeChain;
  not: (...args: unknown[]) => FakeChain;
  in: (...args: unknown[]) => FakeChain;
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
    neq: record("neq"),
    not: record("not"),
    in: record("in"),
    then: (resolve) => resolve(result),
  };
  return chain;
}

function fakeSupabaseClient(chainsByTable: Record<string, FakeChain>): SupabaseClient {
  return {
    from: vi.fn((table: string) => chainsByTable[table]),
  } as unknown as SupabaseClient;
}

const COMPANY_ID = "company-1";

function contactRow(waId: string, displayName: string | null = null) {
  return { whatsapp_wa_id: waId, display_name: displayName, profile_name: null };
}

describe("loadNotificationSummary", () => {
  it("counts three unread inbound customer messages as a bell badge total of 3", async () => {
    const conversationsChain = fakeChain({
      data: [
        {
          id: "conv-1",
          handover_last_read_at: null,
          last_message_at: "2026-08-05T16:28:00Z",
          contacts: contactRow("919820000001", "Test Customer"),
        },
      ],
      error: null,
    });
    const messagesChain = fakeChain({
      data: [
        { conversation_id: "conv-1", created_at: "2026-08-05T16:27:00Z" },
        { conversation_id: "conv-1", created_at: "2026-08-05T16:27:30Z" },
        { conversation_id: "conv-1", created_at: "2026-08-05T16:28:00Z" },
      ],
      error: null,
    });
    const client = fakeSupabaseClient({
      conversations: conversationsChain,
      messages: messagesChain,
    });

    const result = await loadNotificationSummary(client, COMPANY_ID);

    expect(result.totalUnreadCustomerMessages).toBe(3);
    expect(result.unreadConversations).toEqual([
      { conversationId: "conv-1", displayName: "Test Customer", unreadCount: 3 },
    ]);
  });

  it("only counts inbound messages -- outbound AI/human replies never contribute", async () => {
    const conversationsChain = fakeChain({
      data: [
        {
          id: "conv-1",
          handover_last_read_at: null,
          last_message_at: "2026-08-05T16:28:00Z",
          contacts: contactRow("919820000001"),
        },
      ],
      error: null,
    });
    const messagesChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({
      conversations: conversationsChain,
      messages: messagesChain,
    });

    await loadNotificationSummary(client, COMPANY_ID);

    expect(messagesChain.calls).toContainEqual({ method: "eq", args: ["direction", "inbound"] });
  });

  it("scopes the conversations query to the caller's own companyId -- never a cross-tenant value", async () => {
    const conversationsChain = fakeChain({ data: [], error: null });
    const messagesChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({
      conversations: conversationsChain,
      messages: messagesChain,
    });

    await loadNotificationSummary(client, COMPANY_ID);

    expect(conversationsChain.calls).toContainEqual({
      method: "eq",
      args: ["company_id", COMPANY_ID],
    });
  });

  it("is zero with no unread conversations when nothing is a candidate", async () => {
    const conversationsChain = fakeChain({ data: [], error: null });
    const messagesChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({
      conversations: conversationsChain,
      messages: messagesChain,
    });

    const result = await loadNotificationSummary(client, COMPANY_ID);

    expect(result.totalUnreadCustomerMessages).toBe(0);
    expect(result.unreadConversations).toEqual([]);
    // No candidates means the messages table is never even queried.
    expect(messagesChain.calls).toEqual([]);
  });

  it("excludes closed conversations from the candidate query", async () => {
    const conversationsChain = fakeChain({ data: [], error: null });
    const messagesChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({
      conversations: conversationsChain,
      messages: messagesChain,
    });

    await loadNotificationSummary(client, COMPANY_ID);

    expect(conversationsChain.calls).toContainEqual({ method: "neq", args: ["state", "closed"] });
  });

  it("excludes a conversation whose last message predates its last-read timestamp", async () => {
    const conversationsChain = fakeChain({
      data: [
        {
          id: "conv-already-read",
          handover_last_read_at: "2026-08-05T16:30:00Z",
          last_message_at: "2026-08-05T16:28:00Z",
          contacts: contactRow("919820000002"),
        },
      ],
      error: null,
    });
    const messagesChain = fakeChain({ data: [], error: null });
    const client = fakeSupabaseClient({
      conversations: conversationsChain,
      messages: messagesChain,
    });

    const result = await loadNotificationSummary(client, COMPANY_ID);

    expect(result.totalUnreadCustomerMessages).toBe(0);
    expect(messagesChain.calls).toEqual([]);
  });

  it("falls back to profile_name then a masked phone number when no display_name is set", async () => {
    const conversationsChain = fakeChain({
      data: [
        {
          id: "conv-1",
          handover_last_read_at: null,
          last_message_at: "2026-08-05T16:28:00Z",
          contacts: { whatsapp_wa_id: "919820000001", display_name: null, profile_name: null },
        },
      ],
      error: null,
    });
    const messagesChain = fakeChain({
      data: [{ conversation_id: "conv-1", created_at: "2026-08-05T16:28:00Z" }],
      error: null,
    });
    const client = fakeSupabaseClient({
      conversations: conversationsChain,
      messages: messagesChain,
    });

    const result = await loadNotificationSummary(client, COMPANY_ID);

    expect(result.unreadConversations[0]?.displayName).not.toBe("919820000001");
    expect(result.unreadConversations[0]?.displayName).toMatch(/\*/); // masked, per maskPhoneNumber
  });
});
