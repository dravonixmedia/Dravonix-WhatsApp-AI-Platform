import type { RankedSource, ResearchFinding } from "./types.js";

/** Longest excerpt kept per finding -- keeps a WhatsApp-bound answer from ballooning with raw source text. */
const MAX_KEY_FINDINGS_LENGTH = 240;

function excerpt(snippet: string): string {
  const trimmed = snippet.trim();
  if (trimmed.length <= MAX_KEY_FINDINGS_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_KEY_FINDINGS_LENGTH).trimEnd()}...`;
}

export interface SynthesizeFindingsOptions {
  /** Maximum number of ranked sources to turn into findings (cost/latency control, Phase 1 design section 12). */
  maxSources?: number;
}

const DEFAULT_MAX_SOURCES = 5;

/**
 * Turns already-ranked sources into customer-answer-ready findings. In
 * Phase 1 `keyFindings` is a bounded excerpt of the source snippet, not real
 * LLM summarization -- no model call happens here. Every finding is tagged
 * `origin: "external_research"`, the structural marker that keeps research
 * output mechanically distinguishable from company-owned knowledge
 * (see attribution.ts) -- this function never has access to company
 * knowledge and so cannot accidentally blend the two.
 */
export function synthesizeFindings(
  ranked: RankedSource[],
  options: SynthesizeFindingsOptions = {},
): ResearchFinding[] {
  const maxSources = options.maxSources ?? DEFAULT_MAX_SOURCES;
  return ranked.slice(0, maxSources).map((source) => ({
    sourceUrl: source.url,
    sourceTitle: source.title,
    sourceDomain: source.domain,
    publishedAt: source.publishedAt,
    retrievedAt: source.retrievedAt,
    relevance: source.relevanceScore,
    authorityTier: source.authorityTier,
    keyFindings: excerpt(source.snippet),
    origin: "external_research",
  }));
}
