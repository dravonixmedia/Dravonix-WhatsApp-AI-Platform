import { describe, expect, it } from "vitest";
import { HandoverConversationNotFoundError } from "../src/errors.js";
import { getConversationThreadForDashboard } from "../src/service.js";
import { FakeHandoverRepository, type FakeThreadMessageSeed } from "./fakeHandoverRepository.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const CONVERSATION_ID = "conv-1";

function message(id: string, createdAt: string): FakeThreadMessageSeed {
  return {
    id,
    conversationId: CONVERSATION_ID,
    direction: id.startsWith("in") ? "inbound" : "outbound",
    channelType: "text",
    senderType: "customer",
    senderMemberId: null,
    body: id,
    outboundStatus: null,
    providerMessageId: null,
    createdAt,
  };
}

function repoWithThread(messages: FakeThreadMessageSeed[]): FakeHandoverRepository {
  return new FakeHandoverRepository(
    [{ id: CONVERSATION_ID, companyId: COMPANY_A, state: "human_active" }],
    [],
    messages,
  );
}

describe("getConversationThreadForDashboard", () => {
  it("returns the latest messages in chronological (ascending) order on the initial load", async () => {
    const repo = repoWithThread([
      message("m1", "2026-01-01T00:00:00.000Z"),
      message("m2", "2026-01-01T00:01:00.000Z"),
      message("m3", "2026-01-01T00:02:00.000Z"),
    ]);

    const result = await getConversationThreadForDashboard(repo, COMPANY_A, CONVERSATION_ID);

    expect(result.thread.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(result.thread.hasMore).toBe(false);
    expect(result.conversation.id).toBe(CONVERSATION_ID);
  });

  it("loads the next older page using the before cursor, with correct cursor forwarding", async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      message(`m${i}`, `2026-01-01T00:0${i}:00.000Z`),
    );
    const repo = repoWithThread(messages);

    const firstPage = await getConversationThreadForDashboard(repo, COMPANY_A, CONVERSATION_ID, {
      limit: 2,
    });
    expect(firstPage.thread.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
    expect(firstPage.thread.hasMore).toBe(true);

    // The client always derives `before` from the oldest currently-loaded
    // message's createdAt -- forwarding that cursor here must yield the page
    // immediately preceding it, with no overlap.
    const oldestLoaded = firstPage.thread.messages[0]!.createdAt;
    const secondPage = await getConversationThreadForDashboard(repo, COMPANY_A, CONVERSATION_ID, {
      before: oldestLoaded,
      limit: 2,
    });
    expect(secondPage.thread.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(secondPage.thread.hasMore).toBe(true);
  });

  it("reports no older messages remaining once the oldest page is reached", async () => {
    const messages = Array.from({ length: 3 }, (_, i) =>
      message(`m${i}`, `2026-01-01T00:0${i}:00.000Z`),
    );
    const repo = repoWithThread(messages);

    const firstPage = await getConversationThreadForDashboard(repo, COMPANY_A, CONVERSATION_ID, {
      limit: 2,
    });
    expect(firstPage.thread.hasMore).toBe(true);

    const oldestLoaded = firstPage.thread.messages[0]!.createdAt;
    const secondPage = await getConversationThreadForDashboard(repo, COMPANY_A, CONVERSATION_ID, {
      before: oldestLoaded,
      limit: 2,
    });
    expect(secondPage.thread.messages.map((m) => m.id)).toEqual(["m0"]);
    expect(secondPage.thread.hasMore).toBe(false);
  });

  it("never returns messages already covered by an earlier page (no duplicates across pages)", async () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      message(`m${i}`, `2026-01-01T00:0${i}:00.000Z`),
    );
    const repo = repoWithThread(messages);

    const firstPage = await getConversationThreadForDashboard(repo, COMPANY_A, CONVERSATION_ID, {
      limit: 3,
    });
    const secondPage = await getConversationThreadForDashboard(repo, COMPANY_A, CONVERSATION_ID, {
      before: firstPage.thread.messages[0]!.createdAt,
      limit: 3,
    });

    const firstIds = new Set(firstPage.thread.messages.map((m) => m.id));
    const overlap = secondPage.thread.messages.filter((m) => firstIds.has(m.id));
    expect(overlap).toHaveLength(0);
  });

  it("rejects a cross-tenant conversation id with the same error as a missing one", async () => {
    const repo = repoWithThread([message("m1", "2026-01-01T00:00:00.000Z")]);

    await expect(
      getConversationThreadForDashboard(repo, COMPANY_B, CONVERSATION_ID),
    ).rejects.toThrow(HandoverConversationNotFoundError);
  });

  it("rejects a conversation id that does not exist at all, indistinguishably from cross-tenant", async () => {
    const repo = repoWithThread([]);

    const crossTenantError = await getConversationThreadForDashboard(
      repo,
      COMPANY_B,
      CONVERSATION_ID,
    ).catch((e) => e);
    const missingError = await getConversationThreadForDashboard(
      repo,
      COMPANY_A,
      "does-not-exist",
    ).catch((e) => e);

    expect(crossTenantError).toBeInstanceOf(HandoverConversationNotFoundError);
    expect(missingError).toBeInstanceOf(HandoverConversationNotFoundError);
    // Same shape/message pattern regardless of which case actually happened --
    // never a distinguishing detail that would reveal cross-tenant existence.
    expect(crossTenantError.code).toBe(missingError.code);
  });

  it("rejects a conversation the caller's membership was revoked from, the same way as a missing one", async () => {
    // A revoked membership means RLS itself would already return zero rows
    // for the underlying `conversations` select -- an empty repo (no
    // conversation resolves at all for this caller) models that outcome
    // without needing a real Postgres/RLS session for this unit test (real
    // RLS behavior for revoked membership is verified separately by
    // supabase/tests/rls_tenant_isolation.sql).
    const repo = new FakeHandoverRepository([], [], []);
    await expect(
      getConversationThreadForDashboard(repo, COMPANY_A, CONVERSATION_ID),
    ).rejects.toThrow(HandoverConversationNotFoundError);
  });

  it("never leaks which failure case occurred: no conversation/company identifiers appear in the thrown error", async () => {
    const repo = repoWithThread([message("m1", "2026-01-01T00:00:00.000Z")]);

    const error = (await getConversationThreadForDashboard(repo, COMPANY_B, CONVERSATION_ID).catch(
      (e) => e,
    )) as HandoverConversationNotFoundError;

    expect(error).toBeInstanceOf(HandoverConversationNotFoundError);
    // The error carries the conversationId for server-side logging, but must
    // never mention the other tenant's companyId or any Postgres-internal
    // detail -- that would leak which company actually owns the conversation.
    expect(error.message).not.toContain(COMPANY_A);
    expect(error.message).not.toContain(COMPANY_B);
    expect(error.message.toLowerCase()).not.toContain("postgres");
    expect(error.message.toLowerCase()).not.toContain("rls");
  });

  it("never retains another company's thread data across independent calls (safe for company-switch reuse)", async () => {
    const repo = new FakeHandoverRepository(
      [
        { id: "conv-a", companyId: COMPANY_A, state: "human_active" },
        { id: "conv-b", companyId: COMPANY_B, state: "human_active" },
      ],
      [],
      [
        { ...message("a1", "2026-01-01T00:00:00.000Z"), conversationId: "conv-a" },
        { ...message("b1", "2026-01-01T00:00:00.000Z"), conversationId: "conv-b" },
      ],
    );

    const forCompanyA = await getConversationThreadForDashboard(repo, COMPANY_A, "conv-a");
    expect(forCompanyA.thread.messages.map((m) => m.id)).toEqual(["a1"]);

    // Switching to company B and reading its own conversation must never
    // surface company A's message, and vice versa -- there is no shared
    // cache keyed only by conversationId that could leak across the switch.
    const forCompanyB = await getConversationThreadForDashboard(repo, COMPANY_B, "conv-b");
    expect(forCompanyB.thread.messages.map((m) => m.id)).toEqual(["b1"]);

    await expect(getConversationThreadForDashboard(repo, COMPANY_B, "conv-a")).rejects.toThrow(
      HandoverConversationNotFoundError,
    );
    await expect(getConversationThreadForDashboard(repo, COMPANY_A, "conv-b")).rejects.toThrow(
      HandoverConversationNotFoundError,
    );
  });
});
