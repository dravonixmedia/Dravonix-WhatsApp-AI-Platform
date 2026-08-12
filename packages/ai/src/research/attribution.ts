/**
 * Company-fact vs. external-research separation (Phase 1 design report,
 * section 7/9). `ResearchFinding.origin === "external_research"` (types.ts)
 * is the structural tag; this module holds the canonical policy wording
 * (reused wherever prompt copy states the rule, mirroring
 * prompt/languagePolicy.ts's DRAIVA_LANGUAGE_POLICY pattern) plus a
 * heuristic detector usable later as a defense-in-depth structural safety
 * check, the same role safety.ts's ungrounded-claim/follow-up-promise
 * patterns already play for company knowledge.
 */
export const RESEARCH_COMPANY_FACT_SEPARATION_POLICY =
  "Findings returned by the web_research tool describe general public or industry information -- never " +
  "this company's own offerings, claims, or facts. Only knowledge cited via knowledgeSourceIds may be " +
  'attributed to the company itself ("we"/"our team"/"our company"/"our services"). State external research ' +
  'as general context (for example "Current Dubai luxury interiors are seeing increased interest in warm ' +
  'minimalism"), never as a company claim (for example never "We specialize in warm-minimalist Italian ' +
  "marble projects\") unless that fact is separately confirmed by the company's own knowledge.";

// A generic capability/service statement ("Our team can help with villa
// fit-out projects") is explicitly ALLOWED (Phase 1 design report section 9
// worked example) -- only a DEFINITE specialization claim, or a capability
// claim made RESTRICTIVE by a qualifier like "only"/"currently", counts as
// company self-attribution here. Bare mentions of "our team"/"our company"
// alone are deliberately not enough to trigger a match.
const DEFINITE_SPECIALIZATION_PATTERN =
  /\b(we|our team|our company)\b[\s\S]{0,30}\b(specializ(?:e|es|ed)|specialis(?:e|es|ed)|focus(?:es|ed)?\s+(?:on|exclusively)|excels?|are known for|prides?\s+ourselves)\b/i;

const RESTRICTIVE_CAPABILITY_PATTERN =
  /\b(we|our team|our company)\b[\s\S]{0,30}\b(currently|now|always|only|exclusively|solely)\b[\s\S]{0,30}\b(offers?|provides?|uses?|does|do)\b/i;

/**
 * Heuristic detector for company-self-attribution language in a piece of
 * text (for example a draft answer). Intended as the structural check a
 * future safety-rule extension can run against an answer that also used
 * research findings, mirroring safety.ts's containsUngroundedClaim /
 * containsHumanFollowupPromise pattern-based backstops. This function alone
 * does not know whether the attributed claim is actually grounded in
 * company knowledge -- that comparison is the caller's responsibility
 * (Phase 2: cross-reference against knowledgeSourceIds).
 */
export function containsCompanyAttributionLanguage(text: string): boolean {
  return DEFINITE_SPECIALIZATION_PATTERN.test(text) || RESTRICTIVE_CAPABILITY_PATTERN.test(text);
}
