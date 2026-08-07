/**
 * Pure IANA timezone validation and zoned-temporal-context utilities.
 *
 * Knows nothing about Supabase, tenants, companies, or contacts -- see
 * temporalContext.ts for the layer that combines a company/customer pair.
 * All DST and non-integer-offset behaviour comes from the platform's own
 * Intl implementation (never a hand-maintained offset table), so it stays
 * correct as timezone rules change without a code update.
 */

export type Daypart = "morning" | "afternoon" | "evening" | "night";

export interface ZonedTemporalContext {
  timezone: string;
  /** YYYY-MM-DD, in `timezone`'s local calendar. */
  localDate: string;
  /** HH:mm, 24-hour, in `timezone`. */
  localTime: string;
  /** Full English weekday name, e.g. "Monday". */
  dayOfWeek: string;
  daypart: Daypart;
  /** e.g. "+05:30", "-04:00". Reflects DST automatically for `now`. */
  utcOffset: string;
  /** Same as localDate -- kept as a separate named field for prompt clarity. */
  today: string;
  tomorrow: string;
  yesterday: string;
}

/**
 * A bare numeric UTC offset (e.g. "+05:30", "-04:00", "UTC+5:30", "GMT+4")
 * is intentionally rejected even though some Intl implementations resolve
 * it as a usable timeZone value: offsets don't encode DST or historical/
 * future rule changes, so the platform's storage rule (see migration/RPC
 * validation) requires a real IANA identifier as the primary identity.
 */
const BARE_OFFSET_PATTERN = /^(UTC|GMT)?[+-]\d{1,2}(:?\d{2})?$/i;

/**
 * True only for a string Intl actually recognizes as an IANA timezone
 * identifier, excluding bare numeric-offset forms. Never maintains its own
 * allow-list.
 */
export function isValidIanaTimezone(timezone: string): boolean {
  if (typeof timezone !== "string") return false;
  const trimmed = timezone.trim();
  if (trimmed.length === 0) return false;
  if (BARE_OFFSET_PATTERN.test(trimmed)) return false;
  try {
    // eslint-disable-next-line no-new -- constructing is the validation; the
    // instance itself is discarded.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the trimmed timezone string if it is a valid IANA identifier,
 * otherwise null. Never guesses or substitutes a different timezone.
 */
export function normalizeTimezone(timezone: string | null | undefined): string | null {
  if (timezone === null || timezone === undefined) return null;
  const trimmed = timezone.trim();
  return isValidIanaTimezone(trimmed) ? trimmed : null;
}

/**
 * Platform-wide daypart boundaries (documented once, here, so no prompt or
 * UI component invents its own):
 *   morning:   05:00-11:59
 *   afternoon: 12:00-16:59
 *   evening:   17:00-20:59
 *   night:     21:00-04:59
 */
export function resolveDaypart(hour: number, minute: number): Daypart {
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes >= 5 * 60 && totalMinutes < 12 * 60) return "morning";
  if (totalMinutes >= 12 * 60 && totalMinutes < 17 * 60) return "afternoon";
  if (totalMinutes >= 17 * 60 && totalMinutes < 21 * 60) return "evening";
  return "night";
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

function getZonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // hourCycle "h23" can still format midnight as "24" in some engines;
    // normalize to the 0-23 range expected by resolveDaypart/localTime.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    weekday: map.weekday ?? "",
  };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

function formatCalendarDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * Shifts a local calendar date by `deltaDays`, purely as calendar-day math
 * (never wall-clock/duration math). Anchoring the shift at UTC noon on the
 * given calendar date means the result is immune to DST transitions in the
 * timezone the date came from -- this function never re-enters that
 * timezone's rules at all.
 */
function shiftCalendarDate(year: number, month: number, day: number, deltaDays: number): string {
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + deltaDays);
  return formatCalendarDate(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, anchor.getUTCDate());
}

/**
 * "longOffset" (e.g. "GMT+05:30", "GMT-04:00", "GMT") is the one Intl
 * timeZoneName style with a consistently parseable, minute-precise format
 * across engines -- "shortOffset" is not guaranteed to include minutes for
 * whole-hour zones. DST is already baked into the value Intl returns for
 * this specific instant.
 */
function getUtcOffset(instant: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    hour: "2-digit",
  });
  const raw = formatter.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = raw.match(/GMT([+-]\d{2}:\d{2})/);
  if (match?.[1]) return match[1];
  return "+00:00";
}

/**
 * Builds a full local-calendar/clock snapshot for `timezone` at `now`.
 * `now` is always caller-supplied (never read internally) so this stays
 * deterministic and test-injectable -- see the "no module-scope time" rule.
 * Returns null for an invalid timezone rather than throwing, so a bad
 * stored value can never crash a caller; callers should validate upstream
 * (normalizeTimezone) when they need to distinguish "invalid" from "valid
 * but null result".
 */
export function buildZonedTemporalContext(input: {
  timezone: string;
  now: Date;
}): ZonedTemporalContext | null {
  const timezone = normalizeTimezone(input.timezone);
  if (!timezone) return null;

  const { year, month, day, hour, minute, weekday } = getZonedParts(input.now, timezone);
  const localDate = formatCalendarDate(year, month, day);

  return {
    timezone,
    localDate,
    localTime: `${pad(hour, 2)}:${pad(minute, 2)}`,
    dayOfWeek: weekday,
    daypart: resolveDaypart(hour, minute),
    utcOffset: getUtcOffset(input.now, timezone),
    today: localDate,
    tomorrow: shiftCalendarDate(year, month, day, 1),
    yesterday: shiftCalendarDate(year, month, day, -1),
  };
}
