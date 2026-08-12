import {
  SOURCE_AUTHORITY_WEIGHTS,
  type RankedSource,
  type RawSearchResult,
  type SourceAuthorityTier,
} from "./types.js";

/**
 * Domain-suffix / keyword heuristics for a coarse authority classification.
 * This is a best-effort signal, not a fact-checked verdict -- a `.gov` page
 * can still be wrong, and a `general_web` page can still be excellent. It
 * exists to prefer higher-authority sources when several are available, not
 * to certify any single source. Order matters: first match wins.
 */
const AUTHORITY_HEURISTICS: Array<{
  tier: SourceAuthorityTier;
  test: (domain: string) => boolean;
}> = [
  {
    tier: "official_government",
    test: (d) => /\.gov(\.[a-z]{2})?$/i.test(d) || /\.gov\./i.test(d),
  },
  {
    tier: "recognized_professional_organization",
    test: (d) => /\.org$/i.test(d) && !/wiki|forum|blog/i.test(d),
  },
  {
    tier: "established_industry_publication",
    test: (d) => /(news|journal|magazine|times|post|report|review)/i.test(d),
  },
  { tier: "reputable_general_reporting", test: (d) => /\.(edu|ac\.[a-z]{2})$/i.test(d) },
];

/**
 * Classifies a domain into a coarse authority tier via cheap heuristics
 * (TLD/keyword pattern matching). No live reputation lookup is performed in
 * Phase 1 -- this is intentionally conservative and defaults to
 * `general_web` for anything it cannot confidently classify.
 */
export function classifyAuthorityTier(domain: string): SourceAuthorityTier {
  for (const heuristic of AUTHORITY_HEURISTICS) {
    if (heuristic.test(domain)) return heuristic.tier;
  }
  return "general_web";
}

const WORD_PATTERN = /[a-z0-9]+/gi;

function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(WORD_PATTERN) ?? [];
  return new Set(matches.filter((word) => word.length > 2));
}

/**
 * Naive lexical-overlap relevance score (0-1): the fraction of the query's
 * meaningful words that also appear in the result's title/snippet. This is
 * a placeholder relevance signal for Phase 1 (no embedding/semantic model is
 * wired in) -- adequate to rank a small result set, not a claim of true
 * topical understanding.
 */
export function scoreRelevance(
  query: string,
  result: Pick<RawSearchResult, "title" | "snippet">,
): number {
  const queryWords = tokenize(query);
  if (queryWords.size === 0) return 0;
  const resultWords = tokenize(`${result.title} ${result.snippet}`);
  let overlap = 0;
  for (const word of queryWords) {
    if (resultWords.has(word)) overlap += 1;
  }
  return overlap / queryWords.size;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
/** Results older than this many days score a fully decayed (but not zero) freshness. */
const FRESHNESS_HALF_LIFE_DAYS = 180;

/**
 * Recency score (0-1), exponential decay from `referenceTime`. A missing
 * `publishedAt` is scored neutrally-low (0.35) rather than zero: absence of
 * a publish date is not evidence the content is stale, but known-fresh
 * content should still rank above it when both are otherwise comparable.
 */
export function scoreFreshness(publishedAt: string | null, referenceTime: Date): number {
  if (!publishedAt) return 0.35;
  const publishedMs = Date.parse(publishedAt);
  if (Number.isNaN(publishedMs)) return 0.35;
  const ageDays = Math.max(0, (referenceTime.getTime() - publishedMs) / MILLISECONDS_PER_DAY);
  return Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);
}

export interface RankSourcesOptions {
  /** Reference time for freshness scoring; defaults to now. Pass explicitly in tests for determinism. */
  now?: Date;
  /** Weights must sum to <= 1; the remainder is implicitly unused headroom, not renormalized. */
  weights?: { authority: number; relevance: number; freshness: number };
  /** Penalty subtracted from composite score per same-domain result beyond the first (encourages source diversity). */
  domainRepeatPenalty?: number;
  query: string;
}

const DEFAULT_WEIGHTS = { authority: 0.4, relevance: 0.4, freshness: 0.2 };
const DEFAULT_DOMAIN_REPEAT_PENALTY = 0.25;

/**
 * Pure, deterministic ranking: classifies authority, scores relevance and
 * freshness, applies a same-domain diversity penalty, and sorts by the
 * resulting composite score (descending). Never mutates the input array.
 * This ranking is a best-effort ordering signal, not an authoritative
 * quality certification of any individual source.
 */
export function rankSources(
  results: RawSearchResult[],
  options: RankSourcesOptions,
): RankedSource[] {
  const now = options.now ?? new Date();
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const domainRepeatPenalty = options.domainRepeatPenalty ?? DEFAULT_DOMAIN_REPEAT_PENALTY;

  const seenDomainCounts = new Map<string, number>();
  const ranked: RankedSource[] = results.map((result) => {
    const authorityTier = classifyAuthorityTier(result.domain);
    const authorityScore = SOURCE_AUTHORITY_WEIGHTS[authorityTier];
    const relevanceScore = scoreRelevance(options.query, result);
    const freshnessScore = scoreFreshness(result.publishedAt, now);

    const priorOccurrences = seenDomainCounts.get(result.domain) ?? 0;
    seenDomainCounts.set(result.domain, priorOccurrences + 1);
    const domainDiversityPenalty = priorOccurrences > 0 ? domainRepeatPenalty : 0;

    const rawScore =
      authorityScore * weights.authority +
      relevanceScore * weights.relevance +
      freshnessScore * weights.freshness -
      domainDiversityPenalty;
    const compositeScore = Math.min(1, Math.max(0, rawScore));

    return {
      ...result,
      authorityTier,
      authorityScore,
      relevanceScore,
      freshnessScore,
      domainDiversityPenalty,
      compositeScore,
    };
  });

  return ranked.sort((a, b) => b.compositeScore - a.compositeScore);
}
