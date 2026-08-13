/**
 * DRAIVA Research -- deterministic research-intent pre-classifier.
 *
 * Repeated staging tests showed that relying solely on Claude's own
 * classification of the WEB RESEARCH prompt's illustrative examples
 * (buildSystemPrompt.ts) was not reliable enough on its own: an explicit
 * customer research request could still silently fall back to the ordinary
 * "I don't have confirmed details" / requiresHuman path. This module adds a
 * small, deterministic, code-level signal -- `researchRequired` -- that
 * `orchestrate.ts` and `providers/anthropicProvider.ts` use to FORCE the
 * research path (via tool_choice, see anthropicProvider.ts) for the highest-
 * confidence explicit cases, instead of leaving the decision entirely to the
 * model's own judgment every time.
 *
 * This is deliberately NOT a giant keyword blacklist and NOT a replacement
 * for Claude's reasoning: it only decides "this turn is explicitly asking
 * DRAIVA to research something." Claude still formulates the actual search
 * query, evaluates results, and synthesizes the final answer (see
 * buildSystemPrompt.ts's WEB RESEARCH section, unchanged). A `false` result
 * here does NOT mean "not a research request" -- it means "not one of the
 * high-confidence explicit patterns," and Claude's own prompt-based judgment
 * (already in place) remains the fallback for everything else, including
 * phrasing and languages this detector doesn't recognize.
 *
 * Two pattern lists, checked in order:
 *  1. SERVICE_CAPABILITY_PATTERNS -- exclusions checked FIRST. These ask
 *     whether THE COMPANY offers research/analysis as one of its own
 *     services (e.g. "Do you offer market research?") and must never
 *     auto-trigger research even though they share vocabulary with a
 *     genuine request -- this is exactly the original staging bug's
 *     confusion, now resolved deterministically instead of by example.
 *  2. RESEARCH_ACTION_PATTERNS -- explicit action-intent signals. Kept to a
 *     small set of core action verbs/phrases in English plus the two other
 *     languages this company's real customers have used in staging
 *     (Spanish, Arabic) -- not an exhaustive per-language translation
 *     table. Extend deliberately, one clear pattern at a time, not by
 *     growing this into a large keyword list.
 */

export interface ResearchIntentDetection {
  researchRequired: boolean;
  /** Which pattern matched, for diagnostics only -- never logged with the message text itself. */
  matchedSignal: string | null;
}

const SERVICE_CAPABILITY_PATTERNS: RegExp[] = [
  // "Do you offer/provide/include/sell market research...?"
  /\bdo\s+(you|we)\s+(offer|provide|include|sell)\b/i,
  // "Is/Are market research one of / part of / included in your services/package?"
  /\b(is|are)\b[\s\S]{0,50}\b(included|part of|one of)\b[\s\S]{0,30}\b(service|services|package|packages|plan|plans|offering|offerings)\b/i,
  // "What services/products do you provide/offer?"
  /\bwhat\s+(services|products)\s+do\s+you\s+(provide|offer)\b/i,
];

const RESEARCH_ACTION_PATTERNS: Array<{ signal: string; pattern: RegExp }> = [
  // English
  {
    signal: "en:polite_request_plus_verb",
    pattern:
      /\b(can you|could you|please|will you)\b[\s\S]{0,20}\b(research|investigate|analyze|analyse|look into|compare)\b/i,
  },
  {
    // Anchored to the START OF A SENTENCE (string start, or right after
    // ./!/? plus whitespace), not just the start of the whole message --
    // a customer very commonly prefixes context before the actual command
    // (e.g. "Imagine we are an interior fit-out company. Research the
    // Kerala market for competing interior fit-out companies."), and the
    // original whole-message anchor missed every one of those.
    signal: "en:imperative_verb",
    pattern: /(?:^|[.!?]\s+)\s*(research|investigate|analyze|analyse|look into|find|compare)\b/i,
  },
  {
    signal: "en:who_are_competitors",
    pattern: /\bwho\s+(are|is)\b[\s\S]{0,15}\b(our|the|your|my)\b[\s\S]{0,10}\bcompetitors?\b/i,
  },
  {
    signal: "en:do_an_analysis",
    pattern: /\bdo\s+(a|an)\s+[\w\s]{0,20}\b(analysis|research|comparison)\b/i,
  },
  { signal: "en:look_into", pattern: /\blook\s+into\b/i },
  {
    signal: "en:find_competitors",
    pattern: /\bfind\s+(the\s+)?(main\s+|top\s+)?competitors\b/i,
  },
  { signal: "en:competitor_or_market_analysis", pattern: /\b(competitor|market)\s+analysis\b/i },
  {
    signal: "en:latest_current_trends",
    pattern:
      /\bwhat('?s| is| are)\b[\s\S]{0,40}\b(latest|current|recent|trending)\b[\s\S]{0,30}\b(trend|trends|happening|going on|news|developments)\b/i,
  },
  {
    signal: "en:whats_happening",
    pattern: /\bwhat('?s| is)\s+(happening|going on|currently happening)\b/i,
  },
  // Spanish -- core verbs only, matching the language mix already seen in
  // this company's real staging traffic.
  {
    signal: "es:polite_request_plus_verb",
    pattern: /\b(puedes?|podrías?|por favor)\b[\s\S]{0,20}\b(investigar|analizar|comparar)\b/i,
  },
  {
    signal: "es:imperative_verb",
    pattern: /^\s*(investiga|investigar|analiza|analizar|compara|comparar|busca)\b/i,
  },
  {
    signal: "es:tendencias_actuales",
    pattern: /\b(últimas?|actuales?|recientes?)\b[\s\S]{0,30}\btendencias?\b/i,
  },
  // Arabic -- core verbs only. \b is unreliable across Arabic script (it is
  // defined against ASCII word characters), so these are plain substring
  // patterns with no word-boundary anchors.
  { signal: "ar:verb", pattern: /(ابحث|تبحث|البحث عن|حلل|تحليل|قارن|مقارنة)/ },
  { signal: "ar:trends", pattern: /(أحدث|آخر).{0,20}(اتجاهات|تطورات)/ },
];

/**
 * Deterministically classifies whether the customer's current message is an
 * explicit RESEARCH ACTION REQUEST. Pure and synchronous -- no model call,
 * no I/O. Callers combine this with the existing researchEnabled double
 * gate (packages/config's RESEARCH_STAGING_ENABLED AND companies.is_demo)
 * before it has any effect on behavior; this function alone never decides
 * whether research is *allowed*, only whether it was *explicitly asked
 * for*.
 */
export function detectResearchIntent(customerMessage: string): ResearchIntentDetection {
  const message = customerMessage.trim();
  if (!message) {
    return { researchRequired: false, matchedSignal: null };
  }

  for (const exclusion of SERVICE_CAPABILITY_PATTERNS) {
    if (exclusion.test(message)) {
      return { researchRequired: false, matchedSignal: null };
    }
  }

  for (const { signal, pattern } of RESEARCH_ACTION_PATTERNS) {
    if (pattern.test(message)) {
      return { researchRequired: true, matchedSignal: signal };
    }
  }

  return { researchRequired: false, matchedSignal: null };
}
