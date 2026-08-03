/**
 * The original seeded default (supabase/migrations/00000000000002_core_tenancy.sql,
 * supabase/seed/002_demo_tenant.sql) made an unauthorized response-time
 * promise -- "Our team will respond as soon as possible" -- with no handover
 * SLA actually behind it. Corrected transparently below for any company
 * still using that exact default text; a genuinely customized fallback
 * message (anything else) is left untouched, since that's the company's own
 * configured wording, not this bug.
 */
const DEPRECATED_TIME_PROMISE_FALLBACK =
  "Automated assistance is temporarily unavailable. Our team will respond as soon as possible.";

const FALLBACK_MESSAGE_EN =
  "I couldn't complete that request automatically. I've shared it with the Dravonix Media team for assistance.";

const FALLBACK_MESSAGE_ML =
  "ഈ അഭ്യർത്ഥന സ്വയമേവ പൂർത്തിയാക്കാൻ കഴിഞ്ഞില്ല. സഹായത്തിനായി ഇത് Dravonix Media ടീമുമായി പങ്കുവെച്ചിട്ടുണ്ട്.";

function isMalayalam(language: string | null | undefined): boolean {
  return (language ?? "").trim().toLowerCase().startsWith("ml");
}

/**
 * Resolves the customer-facing safe-fallback message used when Claude's
 * structured response can't be trusted (see orchestrate.ts's
 * safeFallbackResponse). Chosen by the detected language so a Malayalam
 * customer never receives an English-only apology, and never carries the
 * unauthorized time promise the old default made.
 */
export function resolveFallbackMessage(
  configuredMessage: string,
  language: string | null | undefined,
): string {
  const isDeprecatedDefault = configuredMessage.trim() === DEPRECATED_TIME_PROMISE_FALLBACK;
  if (!isDeprecatedDefault) return configuredMessage;
  return isMalayalam(language) ? FALLBACK_MESSAGE_ML : FALLBACK_MESSAGE_EN;
}
