import { buildZonedTemporalContext, normalizeTimezone, type Daypart } from "./timezone.js";

/**
 * Server-side-resolved temporal context for one AI request (automatic
 * WhatsApp reply or DRAIVA). Pure: takes already-fetched company/customer
 * timezone strings and the current instant, never reads Supabase or a
 * request itself -- callers (message-consumer, voice-consumer, DRAIVA's
 * context loader) own fetching the stored values and computing `now` at
 * request-execution time, never at module scope.
 */
export interface ConversationTemporalContext {
  nowUtc: string;
  company: {
    /** The company's stored, validated timezone -- null if missing/invalid (see resolveConversationTemporalContext). */
    timezone: string | null;
    localDate?: string;
    localTime?: string;
    dayOfWeek?: string;
    daypart?: Daypart;
    utcOffset?: string;
    today?: string;
    tomorrow?: string;
    yesterday?: string;
  };
  customer: {
    /** The customer's stored, validated timezone -- null if unknown. */
    timezone: string | null;
    timezoneKnown: boolean;
    localDate?: string;
    localTime?: string;
    dayOfWeek?: string;
    daypart?: Daypart;
    utcOffset?: string;
    today?: string;
    tomorrow?: string;
    yesterday?: string;
  };
}

/**
 * Resolution policy (Global Timezone + Daypart Awareness spec, section 18):
 *  - Company: stored valid timezone, else UTC as a safe *technical* fallback
 *    only -- `company.timezone` itself still reports null so callers can
 *    surface the configuration gap rather than silently presenting UTC as
 *    if it were the business's real local timezone.
 *  - Customer: stored valid timezone, else explicitly unknown. NEVER falls
 *    back to the company's timezone -- that would misrepresent a company
 *    timezone as customer-local time.
 */
export function resolveConversationTemporalContext(input: {
  companyTimezone: string | null | undefined;
  customerTimezone: string | null | undefined;
  now: Date;
}): ConversationTemporalContext {
  const companyTimezone = normalizeTimezone(input.companyTimezone);
  const companyEffectiveTimezone = companyTimezone ?? "UTC";
  const companyZoned = buildZonedTemporalContext({
    timezone: companyEffectiveTimezone,
    now: input.now,
  });

  const customerTimezone = normalizeTimezone(input.customerTimezone);
  const customerZoned = customerTimezone
    ? buildZonedTemporalContext({ timezone: customerTimezone, now: input.now })
    : null;

  return {
    nowUtc: input.now.toISOString(),
    company: {
      timezone: companyTimezone,
      localDate: companyZoned?.localDate,
      localTime: companyZoned?.localTime,
      dayOfWeek: companyZoned?.dayOfWeek,
      daypart: companyZoned?.daypart,
      utcOffset: companyZoned?.utcOffset,
      today: companyZoned?.today,
      tomorrow: companyZoned?.tomorrow,
      yesterday: companyZoned?.yesterday,
    },
    customer: {
      timezone: customerTimezone,
      timezoneKnown: customerTimezone !== null,
      localDate: customerZoned?.localDate,
      localTime: customerZoned?.localTime,
      dayOfWeek: customerZoned?.dayOfWeek,
      daypart: customerZoned?.daypart,
      utcOffset: customerZoned?.utcOffset,
      today: customerZoned?.today,
      tomorrow: customerZoned?.tomorrow,
      yesterday: customerZoned?.yesterday,
    },
  };
}
