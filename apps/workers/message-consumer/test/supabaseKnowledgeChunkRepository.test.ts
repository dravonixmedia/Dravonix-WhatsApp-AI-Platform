import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { SupabaseKnowledgeChunkRepository } from "../src/repositories/supabaseKnowledgeChunkRepository.js";

/**
 * P1 stabilization: mirrors voice-consumer's identical test -- this
 * repository class had zero test coverage anywhere. See that file's doc
 * comment for why a full PostgREST-transport integration test is deferred
 * (this repo's local test harness deliberately has no PostgREST layer; the
 * underlying RPC itself is covered against a real Postgres database in
 * supabase/tests/rls_knowledge_search.sql).
 */

function fakeSupabaseClient(response: {
  data: unknown;
  error: { message: string } | null;
}): SupabaseClient {
  return {
    rpc: vi.fn(() => Promise.resolve(response)),
  } as unknown as SupabaseClient;
}

describe("SupabaseKnowledgeChunkRepository", () => {
  it("calls search_knowledge_chunks with the exact parameter names the SQL function expects", async () => {
    const client = fakeSupabaseClient({ data: [], error: null });
    const repo = new SupabaseKnowledgeChunkRepository(client);

    await repo.searchChunks("company-a", "what services do you offer", 5);

    expect(client.rpc).toHaveBeenCalledWith("search_knowledge_chunks", {
      p_company_id: "company-a",
      p_query: "what services do you offer",
      p_limit: 5,
    });
  });

  it("maps the RPC's snake_case row shape into KnowledgeChunkMatch", async () => {
    const client = fakeSupabaseClient({
      data: [
        {
          source_id: "source-1",
          title: "Pricing",
          content: "Website packages start at 25000",
          rank: 0.82,
        },
      ],
      error: null,
    });
    const repo = new SupabaseKnowledgeChunkRepository(client);

    const matches = await repo.searchChunks("company-a", "pricing", 5);

    expect(matches).toEqual([
      {
        sourceId: "source-1",
        title: "Pricing",
        content: "Website packages start at 25000",
        rank: 0.82,
      },
    ]);
  });

  it("returns an empty array when the RPC finds no matches, never null/undefined", async () => {
    const client = fakeSupabaseClient({ data: null, error: null });
    const repo = new SupabaseKnowledgeChunkRepository(client);

    const matches = await repo.searchChunks("company-a", "nonexistent query", 5);

    expect(matches).toEqual([]);
  });

  it("propagates a genuine RPC error rather than silently swallowing it", async () => {
    const client = fakeSupabaseClient({
      data: null,
      error: { message: "function search_knowledge_chunks does not exist" },
    });
    const repo = new SupabaseKnowledgeChunkRepository(client);

    await expect(repo.searchChunks("company-a", "pricing", 5)).rejects.toThrow(
      "function search_knowledge_chunks does not exist",
    );
  });
});
