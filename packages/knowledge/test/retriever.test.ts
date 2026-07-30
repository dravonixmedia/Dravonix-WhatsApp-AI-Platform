import { describe, expect, it } from "vitest";
import {
  PostgresKnowledgeRetriever,
  type KnowledgeChunkMatch,
  type KnowledgeChunkRepository,
} from "../src/retriever.js";

const COMPANY_A = "aaaaaaaa-0000-0000-0000-000000000001";
const COMPANY_B = "bbbbbbbb-0000-0000-0000-000000000002";

/** Simulates a real tenant-scoped repository: it only ever knows about rows tagged with the requested companyId. */
class FakeChunkRepository implements KnowledgeChunkRepository {
  constructor(private readonly data: Record<string, KnowledgeChunkMatch[]>) {}

  async searchChunks(
    companyId: string,
    _query: string,
    limit: number,
  ): Promise<KnowledgeChunkMatch[]> {
    return (this.data[companyId] ?? []).slice(0, limit);
  }
}

describe("PostgresKnowledgeRetriever", () => {
  it("returns only the requesting company's chunks, never another tenant's", async () => {
    const repo = new FakeChunkRepository({
      [COMPANY_A]: [
        { sourceId: "a-1", title: "A Pricing", content: "Company A pricing info", rank: 0.9 },
      ],
      [COMPANY_B]: [
        { sourceId: "b-1", title: "B Pricing", content: "Company B pricing info", rank: 0.9 },
      ],
    });
    const retriever = new PostgresKnowledgeRetriever(repo);

    const resultsForA = await retriever.retrieve(COMPANY_A, "pricing");
    expect(resultsForA).toHaveLength(1);
    expect(resultsForA[0]?.sourceId).toBe("a-1");
    expect(resultsForA.some((r) => r.sourceId === "b-1")).toBe(false);
  });

  it("throws rather than silently querying without a company filter when companyId is empty", async () => {
    const repo = new FakeChunkRepository({});
    const retriever = new PostgresKnowledgeRetriever(repo);
    await expect(retriever.retrieve("", "pricing")).rejects.toThrow(/companyId/);
  });

  it("filters out matches below the minimum relevance threshold (treated as missing knowledge)", async () => {
    const repo = new FakeChunkRepository({
      [COMPANY_A]: [
        { sourceId: "a-1", title: "Strong match", content: "...", rank: 0.9 },
        { sourceId: "a-2", title: "Weak match", content: "...", rank: 0.05 },
      ],
    });
    const retriever = new PostgresKnowledgeRetriever(repo, { minRelevance: 0.15 });

    const results = await retriever.retrieve(COMPANY_A, "something");
    expect(results.map((r) => r.sourceId)).toEqual(["a-1"]);
  });

  it("normalizes rank into a [0, 1] relevance score", async () => {
    const repo = new FakeChunkRepository({
      [COMPANY_A]: [{ sourceId: "a-1", title: "Match", content: "...", rank: 2 }],
    });
    const retriever = new PostgresKnowledgeRetriever(repo, { maxExpectedRank: 4 });

    const [result] = await retriever.retrieve(COMPANY_A, "something");
    expect(result?.relevance).toBe(0.5);
  });

  it("returns an empty array (missing knowledge) rather than throwing when nothing matches", async () => {
    const repo = new FakeChunkRepository({ [COMPANY_A]: [] });
    const retriever = new PostgresKnowledgeRetriever(repo);
    expect(await retriever.retrieve(COMPANY_A, "anything")).toEqual([]);
  });
});
