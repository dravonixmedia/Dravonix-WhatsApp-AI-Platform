/**
 * A small, safe fallback list used only if the runtime doesn't support
 * `Intl.supportedValuesOf` (older engines) -- covers one representative
 * IANA zone per major region so the timezone selector never ends up empty.
 * Never used as a hidden default value; purely a selector-population
 * fallback (Global Timezone + Daypart Awareness spec, section 47).
 */
const FALLBACK_TIMEZONES: readonly string[] = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Kathmandu",
  "Asia/Karachi",
  "Asia/Dhaka",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Lagos",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/**
 * Intl.supportedValuesOf("timeZone") returns only ICU's "canonical" zone
 * IDs and silently omits legacy-but-still-valid backward-compatibility
 * links -- verified directly against this runtime's ICU data:
 * Intl.supportedValuesOf("timeZone") does not include "Asia/Kolkata" (ICU
 * canonicalizes it to "Asia/Calcutta") or "Asia/Kathmandu" (canonicalizes
 * to "Asia/Katmandu"). Both spellings remain real, valid IANA identifiers
 * that Postgres's own pg_timezone_names accepts and that
 * Intl.DateTimeFormat happily constructs with -- and "Asia/Kolkata" is
 * companies.timezone's own database default (migration 2). Silently
 * relying on Intl.supportedValuesOf alone would exclude a company's own
 * already-saved default timezone from its own selector -- a real,
 * reproduced cause of "the selector only shows my current value and I
 * can't pick anything else," since the saved value would never match any
 * option in the list. Patched in explicitly, by name, with the reason
 * documented -- not a hand-written replacement list (the other ~418
 * zones still come from Intl.supportedValuesOf itself).
 */
const CANONICAL_GAPS: readonly string[] = ["Asia/Kolkata", "Asia/Kathmandu"];

/**
 * Every IANA timezone identifier the current runtime knows about, sorted,
 * plus the small canonical-alias patch above. Used to populate the
 * searchable Business Timezone / Customer Timezone selectors
 * (Intl.supportedValuesOf, no external timezone library).
 */
export function listSupportedTimezones(): readonly string[] {
  const supported = (() => {
    if (typeof Intl.supportedValuesOf !== "function") return null;
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return null;
    }
  })();

  if (!supported) return FALLBACK_TIMEZONES;

  const merged = new Set(supported);
  for (const zone of CANONICAL_GAPS) merged.add(zone);
  return Array.from(merged).sort();
}
