/**
 * Presentation-only date/time formatting for the dashboard and Super Admin
 * UI. The stored value is always UTC (never changed here); this only
 * controls how it is *displayed*. Server Components render inside the
 * Cloudflare Worker, whose host runtime default timezone is UTC -- calling
 * `.toLocaleString()` with no explicit `timeZone` there silently formats in
 * UTC regardless of who's viewing it, which is the bug this file exists to
 * fix. Every call site must pass the relevant company's `companies.timezone`
 * explicitly; there is no implicit "current" timezone here.
 */

const FALLBACK_TIMEZONE = "UTC";

function isValidTimeZone(timezone: string | null | undefined): timezone is string {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the timezone to actually format with, per the product's fallback
 * precedence: (1) the given company timezone, (2) UTC as the last-resort
 * technical fallback. There is currently no separate "platform default
 * timezone" concept anywhere in the codebase to sit between those two, so
 * this is a straight two-tier fallback rather than three.
 */
export function resolveDisplayTimezone(companyTimezone: string | null | undefined): string {
  return isValidTimeZone(companyTimezone) ? companyTimezone : FALLBACK_TIMEZONE;
}

/**
 * Formats an ISO/Date value for display in a specific IANA timezone, e.g.
 * "25 Aug 2026, 9:55 AM". Never throws: an invalid timestamp renders as
 * "--", and an invalid/missing timezone silently falls back to UTC so the
 * dashboard never crashes over a bad value -- it just shows UTC, which is
 * still correct, just not localized.
 */
export function formatDateTime(
  value: string | Date | null | undefined,
  timezone: string | null | undefined,
): string {
  if (!value) return "--";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";

  const tz = resolveDisplayTimezone(timezone);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: FALLBACK_TIMEZONE,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);
  }
}
