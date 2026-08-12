import { sanitizeResearchQuery, type QuerySanitizationContext } from "./querySanitizer.js";
import { rankSources } from "./sourceRanker.js";
import { synthesizeFindings } from "./researchSynthesizer.js";
import { filterWellFormedResults } from "./rawSearchResultSchema.js";
import type { WebResearchProvider } from "./provider.js";
import type { ResearchToolResult } from "./types.js";

/**
 * Enforces "at most one research round trip per customer turn" structurally
 * rather than by caller discipline. A new instance must be created per
 * customer turn -- never reused across turns or shared across conversations.
 * No autonomous loop, no recursive research, no multi-agent workflow: once
 * `tryConsume()` has returned true, every subsequent call returns false for
 * the lifetime of this instance.
 */
export class ResearchCallBudget {
  private spent = false;

  tryConsume(): boolean {
    if (this.spent) return false;
    this.spent = true;
    return true;
  }

  get isExhausted(): boolean {
    return this.spent;
  }
}

export interface BoundedResearchExecutionInput {
  /** The model-provided (or test-provided) query, before sanitization. */
  rawQuery: string;
  sanitizationContext?: QuerySanitizationContext;
  provider: WebResearchProvider;
  budget: ResearchCallBudget;
  now?: Date;
  maxSources?: number;
}

/**
 * Executes at most one bounded research round trip: sanitize -> provider
 * search -> rank -> synthesize -> return. This is the Phase 1 stand-in for
 * the eventual `Claude tool_use -> research provider -> tool_result ->
 * final structured response` flow (Phase 2+): today it is only exercised
 * with MockWebResearchProvider in tests, never wired into a live Claude
 * call. A provider error or timeout never throws past this function and
 * never fabricates findings -- callers get a `success: false` result and
 * fall back to the existing "not certain" / handover behavior.
 */
export async function executeBoundedResearch(
  input: BoundedResearchExecutionInput,
): Promise<ResearchToolResult> {
  const now = input.now ?? new Date();
  const executedAt = now.toISOString();

  if (!input.budget.tryConsume()) {
    return {
      query: input.rawQuery,
      findings: [],
      success: false,
      failureReason: "call_limit_exceeded",
      executedAt,
    };
  }

  const sanitized = sanitizeResearchQuery(input.rawQuery, input.sanitizationContext);

  let rawResults;
  try {
    rawResults = await input.provider.search(sanitized.query);
  } catch {
    return {
      query: sanitized.query,
      findings: [],
      success: false,
      failureReason: "provider_error",
      executedAt,
    };
  }

  const wellFormedResults = filterWellFormedResults(rawResults);
  const ranked = rankSources(wellFormedResults, { query: sanitized.query, now });
  const findings = synthesizeFindings(ranked, { maxSources: input.maxSources });

  if (findings.length === 0) {
    return {
      query: sanitized.query,
      findings: [],
      success: false,
      failureReason: "no_relevant_sources",
      executedAt,
    };
  }

  return { query: sanitized.query, findings, success: true, failureReason: null, executedAt };
}
