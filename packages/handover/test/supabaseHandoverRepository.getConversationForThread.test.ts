import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { SupabaseHandoverRepository } from "../src/repositories/supabaseHandoverRepository.js";

interface QueryResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

/** Minimal chainable stub of the one query getConversationForThread issues. */
function fakeSupabaseClient(result: QueryResult): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("SupabaseHandoverRepository.getConversationForThread", () => {
  it("returns null (not-found) for a malformed conversation id, never leaking the Postgres error text", async () => {
    const client = fakeSupabaseClient({
      data: null,
      error: { code: "22P02", message: 'invalid input syntax for type uuid: "not-a-uuid"' },
    });
    const repo = new SupabaseHandoverRepository(client);

    const result = await repo.getConversationForThread("not-a-uuid");
    expect(result).toBeNull();
  });

  it("returns null when RLS hides the row (revoked membership or cross-tenant), same as a missing row", async () => {
    const client = fakeSupabaseClient({ data: null, error: null });
    const repo = new SupabaseHandoverRepository(client);

    const result = await repo.getConversationForThread("11111111-1111-1111-1111-111111111111");
    expect(result).toBeNull();
  });

  it("still throws for a genuinely unexpected database error (never silently swallowed)", async () => {
    const client = fakeSupabaseClient({
      data: null,
      error: { code: "53300", message: "too many connections" },
    });
    const repo = new SupabaseHandoverRepository(client);

    await expect(
      repo.getConversationForThread("11111111-1111-1111-1111-111111111111"),
    ).rejects.toThrow("too many connections");
  });

  it("maps a found row into the expected camelCase shape", async () => {
    const client = fakeSupabaseClient({
      data: {
        id: "conv-1",
        company_id: "company-a",
        state: "human_active",
        ai_mode: "active",
        assigned_member_id: "member-1",
        handover_reason: "urgent",
      },
      error: null,
    });
    const repo = new SupabaseHandoverRepository(client);

    const result = await repo.getConversationForThread("conv-1");
    expect(result).toEqual({
      id: "conv-1",
      companyId: "company-a",
      state: "human_active",
      aiMode: "active",
      assignedMemberId: "member-1",
      handoverReason: "urgent",
    });
  });
});
