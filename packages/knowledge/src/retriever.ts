export interface RetrievedKnowledgeSnippet {
  sourceId: string;
  title: string;
  content: string;
  relevance: number;
}

export interface KnowledgeChunkMatch {
  sourceId: string;
  title: string;
  content: string;
  /** Raw ranking score from the search backend (e.g. Postgres ts_rank), not yet normalized to [0, 1]. */
  rank: number;
}

/**
 * Tenant-scoped chunk search. The `companyId` filter MUST be applied by the
 * implementation before ranking/limiting -- never as a post-filter -- so a
 * cross-tenant chunk can never appear in results regardless of query content
 * (Master Prompt section 13/36: "knowledge retrieval must apply the company
 * filter before ranking or returning results").
 */
export interface KnowledgeChunkRepository {
  searchChunks(companyId: string, query: string, limit: number): Promise<KnowledgeChunkMatch[]>;
}

export interface KnowledgeRetriever {
  retrieve(companyId: string, query: string, limit?: number): Promise<RetrievedKnowledgeSnippet[]>;
}

export interface KnowledgeRetrieverOptions {
  /** Minimum normalized relevance to include a match; below this, knowledge is treated as "missing" (Master Prompt section 13). */
  minRelevance?: number;
  /** Rank value considered "perfect" for normalization purposes; tune per search backend. */
  maxExpectedRank?: number;
}

/**
 * Default retriever: Postgres full-text search results, normalized and
 * threshold-filtered. Does not send the whole knowledge base to the AI layer
 * (Master Prompt section 13) -- callers pass the returned snippets, and only
 * those, into the AI prompt.
 */
export class PostgresKnowledgeRetriever implements KnowledgeRetriever {
  private readonly minRelevance: number;
  private readonly maxExpectedRank: number;

  constructor(
    private readonly repo: KnowledgeChunkRepository,
    options: KnowledgeRetrieverOptions = {},
  ) {
    this.minRelevance = options.minRelevance ?? 0.15;
    this.maxExpectedRank = options.maxExpectedRank ?? 1;
  }

  async retrieve(
    companyId: string,
    query: string,
    limit = 5,
  ): Promise<RetrievedKnowledgeSnippet[]> {
    if (!companyId) {
      throw new Error("PostgresKnowledgeRetriever.retrieve requires a companyId");
    }

    const matches = await this.repo.searchChunks(companyId, query, limit);

    return matches
      .map((match) => ({
        sourceId: match.sourceId,
        title: match.title,
        content: match.content,
        relevance: Math.min(1, match.rank / this.maxExpectedRank),
      }))
      .filter((snippet) => snippet.relevance >= this.minRelevance);
  }
}
