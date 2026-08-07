import type { ConversationTemporalContext } from "@dravonix/core";

/**
 * Renders the CURRENT TEMPORAL CONTEXT block shared by both the automatic
 * WhatsApp reply prompt (buildSystemPrompt.ts) and the DRAIVA prompt
 * (chatAgent/systemPrompt.ts) -- one implementation so the two prompts can
 * never drift into different daypart/timezone framing (Global Timezone +
 * Daypart Awareness spec, section 21/24). Never hardcodes an example date
 * or a specific region: every value below comes from `temporal`, which is
 * itself computed per-request from real stored timezones.
 */
export function renderTemporalContextBlock(temporal: ConversationTemporalContext): string {
  const lines: string[] = ["CURRENT TEMPORAL CONTEXT", "", `UTC: ${temporal.nowUtc}`, ""];

  lines.push("BUSINESS:");
  if (temporal.company.timezone) {
    lines.push(
      `Timezone: ${temporal.company.timezone}`,
      `Local date: ${temporal.company.localDate}`,
      `Local time: ${temporal.company.localTime}`,
      `Day: ${temporal.company.dayOfWeek}`,
      `Daypart: ${temporal.company.daypart}`,
      `Tomorrow: ${temporal.company.tomorrow}`,
      `Yesterday: ${temporal.company.yesterday}`,
    );
  } else {
    lines.push(
      "Timezone: NOT CONFIGURED (using UTC as a technical fallback only -- do not present this as the business's real local time)",
      `UTC-fallback local date: ${temporal.company.localDate}`,
      `UTC-fallback local time: ${temporal.company.localTime}`,
    );
  }

  lines.push("", "CUSTOMER:");
  if (temporal.customer.timezoneKnown && temporal.customer.timezone) {
    lines.push(
      `Timezone: ${temporal.customer.timezone}`,
      `Local date: ${temporal.customer.localDate}`,
      `Local time: ${temporal.customer.localTime}`,
      `Day: ${temporal.customer.dayOfWeek}`,
      `Daypart: ${temporal.customer.daypart}`,
      `Tomorrow: ${temporal.customer.tomorrow}`,
      `Yesterday: ${temporal.customer.yesterday}`,
    );
  } else {
    lines.push(
      "Timezone: UNKNOWN",
      "Do not infer customer-local daypart or relative dates (today/tomorrow/tonight/this evening) without clarification.",
    );
  }

  return lines.join("\n");
}

/**
 * System-level rules governing how the model must use the block above.
 * Centralized here (rather than repeated per prompt) so both the automatic
 * reply prompt and DRAIVA enforce the identical policy.
 */
export const TEMPORAL_PROMPT_RULES: readonly string[] = [
  "Treat the CURRENT TEMPORAL CONTEXT block above as authoritative for the current date/time -- never use your " +
    "training-date assumptions, and never treat server/Cloudflare UTC as if it were the customer's local time.",
  "Never invent or guess a customer timezone. If CUSTOMER timezone is UNKNOWN, do not decide whether it is " +
    "morning, afternoon, evening, or night for the customer, and do not resolve relative phrases such as " +
    '"tomorrow morning", "tonight", "this evening", or "later today" into an absolute date/time on your own.',
  "When customer timezone is unknown and a relative time phrase materially affects the meaning of your reply " +
    "(e.g. scheduling a callback), ask which timezone to use rather than assuming one -- but do not ask when " +
    "timing is not actually relevant to the request.",
  'Avoid time-of-day greetings ("Good morning", "Good afternoon", "Good evening") unless the customer\'s local ' +
    "daypart is actually known, or you are simply mirroring a greeting the customer themselves just used.",
  "Interpret the customer's own relative-date language using CUSTOMER local time when known. Use BUSINESS " +
    "local time for your own operational statements (e.g. business hours, staff availability).",
  "When business and customer timezones differ and you state a specific time for an appointment or deadline, " +
    "state which timezone it is in (e.g. a city/timezone name) rather than leaving it ambiguous.",
  "Understanding a relative time phrase is not authorization to commit the company to it. Follow the existing " +
    "requiresHuman/handover rules exactly as before -- never claim a callback, meeting, or follow-up is " +
    "confirmed unless the system has actually recorded and authorized that commitment.",
].map((rule) => `- ${rule}`);
