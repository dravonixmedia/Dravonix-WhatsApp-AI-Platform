import type { AiStructuredResponse } from "./schema.js";

/**
 * Heuristic patterns indicating the answer makes a pricing, availability, or
 * business-hours claim -- the categories Master Prompt section 12 requires to
 * be grounded in approved knowledge. This is a defense-in-depth structural
 * check on top of the prompt-level instruction (ADR-0004); it cannot prove the
 * answer is correct, only that an ungrounded claim in these categories is
 * downgraded rather than sent to the customer as if certain.
 */
const UNGROUNDED_CLAIM_PATTERNS: RegExp[] = [
  /[₹$€£]\s?\d/, // currency amounts
  /\brs\.?\s?\d/i,
  /\d+\s?(per|\/)\s?(month|year|hour|day|week)/i,
  /\bavailable\b/i,
  /\bin stock\b/i,
  /\bopen (from|between|on)\b/i,
  /\bbusiness hours\b/i,
];

function containsUngroundedClaim(answer: string): boolean {
  return UNGROUNDED_CLAIM_PATTERNS.some((pattern) => pattern.test(answer));
}

/**
 * Applies structural safety rules to an already schema-valid AI response,
 * returning a possibly-modified copy. Forces requiresHuman=true (and records a
 * handoverReason) when the answer appears to make a pricing/availability/hours
 * claim without citing any knowledgeSourceIds.
 */
export function applySafetyRules(response: AiStructuredResponse): AiStructuredResponse {
  const hasGrounding = response.knowledgeSourceIds.length > 0;

  if (!hasGrounding && containsUngroundedClaim(response.answer)) {
    return {
      ...response,
      requiresHuman: true,
      handoverReason: response.handoverReason ?? "missing_knowledge_grounding",
      confidence: Math.min(response.confidence, 0.4),
    };
  }

  return response;
}
