import type Anthropic from "@anthropic-ai/sdk";
import { classifyAuthorityTier } from "./sourceRanker.js";
import type {
  LiveResearchExecutionMetadata,
  ResearchFailureReason,
  ResearchFinding,
} from "./types.js";

/**
 * DRAIVA Research -- live provider adapter for Anthropic's official,
 * server-executed Web Search tool (`web_search_20250305`). Distinct from the
 * Phase 1 mock-oriented WebResearchProvider/rankSources/synthesizeFindings
 * pipeline (still valid, still used by tests and the future custom-tool
 * path) -- Anthropic's web search runs entirely on Anthropic's own
 * infrastructure within a single `messages.create()` call, so there is no
 * client-executed `search(query)` step to wrap. This module only maps the
 * completed response's content blocks into this platform's existing,
 * provider-agnostic research types.
 */

/**
 * Conservative default for the initial staging rollout (task requirement):
 * at most this many individual web_search invocations within ONE Claude
 * call. providers/anthropicProvider.ts additionally never attaches this
 * tool to a repair-attempt call, so a customer turn can never exceed this
 * many searches in total, even across a first-attempt + repair pair.
 */
export const ANTHROPIC_WEB_SEARCH_MAX_USES = 3;

/** Structurally compatible with Anthropic.WebSearchTool20250305.UserLocation -- kept as a local, minimal type rather than reaching into the SDK's merged namespace export. */
export interface AnthropicWebSearchUserLocation {
  type: "approximate";
  city?: string | null;
  region?: string | null;
  country?: string | null;
  timezone?: string | null;
}

export interface BuildAnthropicWebSearchToolOptions {
  /** Defaults to ANTHROPIC_WEB_SEARCH_MAX_USES (3). */
  maxUses?: number;
  /**
   * Domain-restriction capability, kept available for a future industry-
   * specific or government/regulatory-only research mode (Phase 2 design
   * report section 12) -- deliberately left unset by the current staging
   * wiring rather than a hard-coded, made-up domain list.
   */
  allowedDomains?: string[];
  blockedDomains?: string[];
  /**
   * Public, business-level location context only (e.g. a company's own
   * market region) -- never derived from a customer's personal address.
   * Left unset by the current staging wiring: no existing, safe field
   * carries a company's public market region yet (Phase 2 design report
   * section 11) -- Claude's own generated search query text already
   * carries location terms when relevant (e.g. "Kerala interior fit-out
   * market"), which this parameter would only refine further.
   */
  userLocation?: AnthropicWebSearchUserLocation;
}

/** Builds the web_search tool config passed in `messages.create({ tools: [...] })`. */
export function buildAnthropicWebSearchTool(
  options: BuildAnthropicWebSearchToolOptions = {},
): Anthropic.WebSearchTool20250305 {
  return {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: options.maxUses ?? ANTHROPIC_WEB_SEARCH_MAX_USES,
    ...(options.allowedDomains ? { allowed_domains: options.allowedDomains } : {}),
    ...(options.blockedDomains ? { blocked_domains: options.blockedDomains } : {}),
    ...(options.userLocation ? { user_location: options.userLocation } : {}),
  };
}

/**
 * Anthropic's own web_search_tool_result_error codes, mapped to this
 * platform's provider-agnostic ResearchFailureReason (types.ts) -- the exact
 * classification the failure-handling requirement (Phase 2 design report
 * section 13) asks for: rate limit, provider config problem, or a generic
 * transient provider failure. Never exposed to the customer directly; only
 * used for sanitized diagnostics (research_reason/failure_category).
 */
const WEB_SEARCH_ERROR_CLASSIFICATION: Record<string, ResearchFailureReason> = {
  invalid_tool_input: "invalid_configuration",
  unavailable: "provider_error",
  max_uses_exceeded: "call_limit_exceeded",
  too_many_requests: "rate_limited",
  query_too_long: "invalid_configuration",
};

export function classifyWebSearchErrorCode(errorCode: string): ResearchFailureReason {
  return WEB_SEARCH_ERROR_CLASSIFICATION[errorCode] ?? "provider_error";
}

const MAX_FINDINGS = 5;
const MAX_KEY_FINDINGS_LENGTH = 240;

function excerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_KEY_FINDINGS_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_KEY_FINDINGS_LENGTH).trimEnd()}...`;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Best-effort ISO 8601 normalization of Anthropic's freeform `page_age` string (e.g. "3 days ago" is NOT guaranteed parseable) -- an unparsable value is treated as unknown, never as "old". */
function parsePageAge(pageAge: string | null): string | null {
  if (!pageAge) return null;
  const parsedMs = Date.parse(pageAge);
  return Number.isNaN(parsedMs) ? null : new Date(parsedMs).toISOString();
}

interface CollectedSource {
  title: string;
  pageAge: string | null;
}

/**
 * Maps Anthropic's native web_search content blocks (server_tool_use,
 * web_search_tool_result, and TextBlock citations) into this platform's
 * provider-agnostic ResearchFinding shape, reusing classifyAuthorityTier
 * (sourceRanker.ts) since domain-authority classification is provider-
 * agnostic. Deliberately NOT reusing rankSources/synthesizeFindings from the
 * Phase 1 mock pipeline: those score relevance from a readable `snippet`,
 * which Anthropic's WebSearchResultBlock does not provide (only an opaque
 * `encrypted_content`, unreadable by design -- it exists purely so
 * Anthropic can re-verify a citation server-side, not for us to read).
 *
 * The actually-useful readable text is Claude's own citation `cited_text` --
 * the exact passage Claude drew from that source into its answer -- which is
 * a strictly better "key finding" than an independently-guessed snippet
 * excerpt, since it reflects what Claude actually used. A source Claude
 * fetched but never cited still appears (lower relevance, no keyFindings
 * text) so source_count diagnostics reflect everything the tool returned,
 * not only what made it into the final answer.
 *
 * Never reads `encrypted_content` -- there is nothing readable in it to
 * leak, but it is also never copied into ResearchFinding regardless.
 */
export function extractResearchExecutionMetadata(
  content: Anthropic.ContentBlock[],
  now: Date,
): LiveResearchExecutionMetadata {
  const searchQueries: string[] = [];
  let failureReason: ResearchFailureReason | null = null;

  const sourcesByUrl = new Map<string, CollectedSource>();
  const citedTextByUrl = new Map<string, string[]>();

  for (const block of content) {
    if (block.type === "server_tool_use" && block.name === "web_search") {
      const input = block.input as { query?: unknown } | null | undefined;
      if (input && typeof input.query === "string") {
        searchQueries.push(input.query);
      }
      continue;
    }

    if (block.type === "web_search_tool_result") {
      if (Array.isArray(block.content)) {
        for (const result of block.content) {
          if (!sourcesByUrl.has(result.url)) {
            sourcesByUrl.set(result.url, { title: result.title, pageAge: result.page_age });
          }
        }
      } else {
        failureReason ??= classifyWebSearchErrorCode(block.content.error_code);
      }
      continue;
    }

    if (block.type === "text" && block.citations) {
      for (const citation of block.citations) {
        if (citation.type !== "web_search_result_location") continue;
        const existing = citedTextByUrl.get(citation.url) ?? [];
        existing.push(citation.cited_text);
        citedTextByUrl.set(citation.url, existing);
        if (!sourcesByUrl.has(citation.url)) {
          sourcesByUrl.set(citation.url, {
            title: citation.title ?? citation.url,
            pageAge: null,
          });
        }
      }
    }
  }

  const retrievedAt = now.toISOString();
  const findings: ResearchFinding[] = Array.from(sourcesByUrl.entries())
    .map(([url, source]) => {
      const citedText = citedTextByUrl.get(url) ?? [];
      const domain = hostnameOf(url);
      return {
        sourceUrl: url,
        sourceTitle: source.title,
        sourceDomain: domain,
        publishedAt: parsePageAge(source.pageAge),
        retrievedAt,
        // A cited source is one Claude actually judged useful enough to draw
        // from -- treated as maximally relevant. An uncited-but-returned
        // source is kept (for source_count completeness) but scored lower,
        // since Claude itself passed over it when writing the answer.
        relevance: citedText.length > 0 ? 1 : 0.4,
        authorityTier: classifyAuthorityTier(domain),
        keyFindings: citedText.length > 0 ? excerpt(citedText.join(" ")) : "",
        origin: "external_research" as const,
      };
    })
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_FINDINGS);

  return {
    searchesPerformed: searchQueries.length,
    searchQueries,
    findings,
    failureReason,
  };
}
