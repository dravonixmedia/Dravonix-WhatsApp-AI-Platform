import { DRAIVA_LANGUAGE_POLICY } from "../prompt/languagePolicy.js";

/**
 * Extends the canonical multilingual policy (prompt/languagePolicy.ts) to
 * research explicitly: web research findings are very often in English
 * regardless of the customer's language, and that must never change which
 * language the final customer-facing answer is produced in. This module
 * reuses DRAIVA_LANGUAGE_POLICY verbatim rather than restating it, so the
 * two never drift (mirrors languagePolicyConsistency.test.ts's existing
 * cross-prompt check). No language whitelist is introduced here or anywhere
 * in the research module -- `enabledLanguages` remains the sole,
 * company-configured, open-ended source of truth (see provider.ts's
 * CompanyAiContext), exactly as it is today.
 */
export const RESEARCH_LANGUAGE_SYNTHESIS_POLICY =
  `${DRAIVA_LANGUAGE_POLICY} Web research findings may themselves be in any language (most commonly ` +
  "English) -- that never changes which language the final customer-facing answer is synthesized into. " +
  "Research must never introduce a language whitelist or restrict which languages research-backed answers " +
  "may be produced in.";
