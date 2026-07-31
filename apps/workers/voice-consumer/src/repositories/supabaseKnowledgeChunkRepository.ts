import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeChunkMatch, KnowledgeChunkRepository } from "@dravonix/knowledge";

interface SearchKnowledgeChunksRow {
  source_id: string;
  title: string;
  content: string;
  rank: number;
}

/**
 * Postgres full-text search over knowledge_chunks via the search_knowledge_chunks
 * RPC (supabase/migrations/00000000000011_knowledge_search_or_matching.sql). The
 * company filter is applied inside the SQL function itself, before ranking or
 * limiting (Master Prompt section 13/36).
 */
export class SupabaseKnowledgeChunkRepository implements KnowledgeChunkRepository {
  constructor(private readonly client: SupabaseClient) {}

  async searchChunks(
    companyId: string,
    query: string,
    limit: number,
  ): Promise<KnowledgeChunkMatch[]> {
    const { data, error } = await this.client.rpc("search_knowledge_chunks", {
      p_company_id: companyId,
      p_query: query,
      p_limit: limit,
    });
    if (error) throw error;

    return ((data ?? []) as SearchKnowledgeChunksRow[]).map((row) => ({
      sourceId: row.source_id,
      title: row.title,
      content: row.content,
      rank: row.rank,
    }));
  }
}
