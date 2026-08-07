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
 * Every IANA timezone identifier the current runtime knows about, sorted.
 * Used to populate the searchable Business Timezone / Customer Timezone
 * selectors (Intl.supportedValuesOf, no external timezone library).
 */
export function listSupportedTimezones(): readonly string[] {
  if (typeof Intl.supportedValuesOf === "function") {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return FALLBACK_TIMEZONES;
    }
  }
  return FALLBACK_TIMEZONES;
}
