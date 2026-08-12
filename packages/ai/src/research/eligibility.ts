import type { RetrievedKnowledgeSnippet } from "../provider.js";

/**
 * The ONLY deterministic branch of the future decision layer: whether
 * already-retrieved company knowledge is relevant enough that research is
 * unnecessary. Deliberately NOT a keyword-based classifier for "does this
 * question need research" -- that judgment stays with the model (Claude),
 * which sees the full question, company context, and knowledge in its
 * prompt and is far better positioned than a regex to tell "what's trending
 * in villa interiors right now" apart from "what services do you offer"
 * (Phase 1 design report, section 5/8). This function only ever narrows the
 * model's choice to "skip research" or "you may decide" -- it never itself
 * decides "do research".
 */
export type ResearchEligibilityDecision =
  "company_knowledge_sufficient" | "research_disabled" | "eligible_for_model_decision";

export interface ResearchEligibility {
  decision: ResearchEligibilityDecision;
  reason: string;
  /** The best (highest) relevance score among the retrieved knowledge snippets, 0 if none were retrieved. */
  bestKnowledgeRelevance: number;
}

export interface ResearchEligibilityInput {
  knowledge: RetrievedKnowledgeSnippet[];
  /** Per-company research toggle (Phase 1: not yet backed by a DB column -- see Phase 1 report "whether a database migration is needed"). */
  researchEnabled: boolean;
  /** Relevance at/above which company knowledge is treated as sufficient on its own. Distinct from KnowledgeRetriever's own minRelevance (which decides whether a snippet is included at all); this threshold decides whether an already-included snippet is good enough to skip research. */
  sufficientRelevance?: number;
}

const DEFAULT_SUFFICIENT_RELEVANCE = 0.6;

export function evaluateResearchEligibility(input: ResearchEligibilityInput): ResearchEligibility {
  const sufficientRelevance = input.sufficientRelevance ?? DEFAULT_SUFFICIENT_RELEVANCE;
  const bestKnowledgeRelevance = input.knowledge.reduce(
    (max, snippet) => Math.max(max, snippet.relevance),
    0,
  );

  if (!input.researchEnabled) {
    return {
      decision: "research_disabled",
      reason: "Research is not enabled for this company.",
      bestKnowledgeRelevance,
    };
  }

  if (bestKnowledgeRelevance >= sufficientRelevance) {
    return {
      decision: "company_knowledge_sufficient",
      reason:
        "Retrieved company knowledge is relevant enough to answer directly; no research needed.",
      bestKnowledgeRelevance,
    };
  }

  return {
    decision: "eligible_for_model_decision",
    reason:
      "Company knowledge is insufficient on its own; the model may choose to research if the question " +
      "genuinely needs current or public information (never forced, never automatic).",
    bestKnowledgeRelevance,
  };
}
