/**
 * DRAIVA Research -- Phase 1 internal architecture (foundation only).
 *
 * This module defines the provider-agnostic shapes for controlled external
 * web research: a raw search result -> a ranked, quality-scored source -> a
 * synthesized finding kept structurally separate from company knowledge.
 * No real search vendor is chosen or connected in this phase (see
 * provider.ts / mockProvider.ts) and no tool is wired into the live
 * customer-facing Claude call.
 */

/** Coarse source-quality tier used by the ranking model (see sourceRanker.ts). Never claim a mock/heuristic classification is authoritative -- it is a best-effort signal, not a fact-checked verdict. */
export type SourceAuthorityTier =
  | "official_government"
  | "official_company_or_product"
  | "established_industry_publication"
  | "recognized_professional_organization"
  | "reputable_general_reporting"
  | "general_web";

/** Relative weight per tier, highest authority first. Tunable later; not a claim of objective truth. */
export const SOURCE_AUTHORITY_WEIGHTS: Record<SourceAuthorityTier, number> = {
  official_government: 1,
  official_company_or_product: 0.9,
  established_industry_publication: 0.75,
  recognized_professional_organization: 0.7,
  reputable_general_reporting: 0.55,
  general_web: 0.3,
};

/** One raw result as returned by a WebResearchProvider, before any ranking or synthesis. */
export interface RawSearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  /** ISO 8601, when the provider reports it. Absent for many pages -- absence is not itself a quality signal. */
  publishedAt: string | null;
  /** ISO 8601, when this platform retrieved the result (not when the page was crawled by the provider). */
  retrievedAt: string;
}

/** A RawSearchResult after quality scoring (see sourceRanker.ts). */
export interface RankedSource extends RawSearchResult {
  authorityTier: SourceAuthorityTier;
  /** 0-1, from SOURCE_AUTHORITY_WEIGHTS via classifyAuthorityTier. */
  authorityScore: number;
  /** 0-1, topical match between the query and this result's title/snippet. */
  relevanceScore: number;
  /** 0-1, recency relative to a reference time; unknown publish date scores low but is not treated as "old". */
  freshnessScore: number;
  /** 0-1, subtracted from the composite score for each same-domain result beyond the first, to avoid one domain dominating synthesis. */
  domainDiversityPenalty: number;
  /** 0-1 final ranking score used to order and select sources for synthesis. */
  compositeScore: number;
}

/**
 * A synthesized, customer-answer-ready finding derived from one ranked
 * source. `origin` is a structural tag, not decoration: it is what lets
 * downstream code (and, in a later phase, a safety rule) mechanically tell
 * external research apart from company-owned facts -- see attribution.ts.
 * `keyFindings` in this phase is a bounded excerpt of the source snippet,
 * not real LLM summarization (no model call is made in Phase 1).
 */
export interface ResearchFinding {
  sourceUrl: string;
  sourceTitle: string;
  sourceDomain: string;
  publishedAt: string | null;
  retrievedAt: string;
  relevance: number;
  authorityTier: SourceAuthorityTier;
  keyFindings: string;
  origin: "external_research";
}

export type ResearchFailureReason =
  | "provider_error"
  | "provider_timeout"
  | "no_relevant_sources"
  | "call_limit_exceeded"
  | "rate_limited"
  | "invalid_configuration";

/**
 * The outcome of one bounded research round trip (see boundedExecution.ts).
 * `success: false` must never be papered over with a fabricated answer --
 * callers fall back to the existing "not certain" / handover behavior.
 */
export interface ResearchToolResult {
  /** The sanitized query actually sent to the provider (see querySanitizer.ts) -- never the raw customer message. */
  query: string;
  findings: ResearchFinding[];
  success: boolean;
  failureReason: ResearchFailureReason | null;
  executedAt: string;
}

/**
 * Sanitized, structural metadata about Anthropic's native web_search tool
 * use during one Claude call (see research/anthropicWebSearch.ts). Distinct
 * from ResearchToolResult (the Phase 1 mock-provider round-trip shape):
 * Anthropic's web search is a SERVER-side tool -- there is no client-executed
 * `search(query)` call to wrap, so this metadata is extracted from the
 * completed Claude response instead. `searchQueries` carries the literal
 * query text Claude sent to the tool (itself public, non-sensitive by
 * construction -- see the web_research tool description's privacy
 * instructions) so a caller with access to this turn's private identifiers
 * (phone number, conversation id) can run a post-hoc sanitizeResearchQuery
 * check without this module ever needing to receive those identifiers
 * itself.
 */
export interface LiveResearchExecutionMetadata {
  /** How many times Claude actually invoked the web_search tool this call (0 if it judged research unnecessary). */
  searchesPerformed: number;
  /** The literal query text/strings Claude sent to web_search, in call order. */
  searchQueries: string[];
  findings: ResearchFinding[];
  /** Set when at least one search failed server-side (e.g. rate limited); does not necessarily mean the whole turn failed if other searches or company knowledge still produced a usable answer. */
  failureReason: ResearchFailureReason | null;
}

/**
 * Sanitized diagnostics for one turn's research usage (Phase 2 design
 * report, section 18 / observability). Never logs raw query text, source
 * content, or provider payloads -- only counts, a short reason string, and
 * a bounded latency measurement.
 */
export interface ResearchExecutionDiagnostics {
  /**
   * True when the deterministic intent detector (research/intentDetector.ts)
   * classified the customer's current message as an explicit research
   * request, independent of whether research was actually enabled for this
   * turn -- lets monitoring distinguish "customer asked for research but the
   * staging gate was off" from "customer never asked."
   */
  researchRequired: boolean;
  /** True when the researchStagingEnabled + companies.is_demo double gate was on for this turn. */
  researchEnabled: boolean;
  /** True when Claude actually invoked web_search at least once this turn (aka "research invoked"). */
  researchStarted: boolean;
  /** True when research started AND completed without an unrecoverable failure. */
  researchCompleted: boolean;
  /** Why research was or wasn't eligible for this turn (see eligibility.ts). */
  researchReason: string;
  /** Number of distinct sources returned this turn (aka "research source count"). */
  sourceCount: number;
  /**
   * Wall-clock duration of the whole provider call that had research
   * enabled, in milliseconds. Anthropic does not expose a per-tool-call
   * timestamp, so this is an upper bound on search-plus-synthesis time
   * combined, not an isolated search-only measurement.
   */
  researchLatencyMs: number;
  failureCategory: ResearchFailureReason | null;
}
