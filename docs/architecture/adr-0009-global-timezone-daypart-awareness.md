# ADR-0009: Global timezone and daypart awareness

## Status

Accepted

## Context

Dravonix serves businesses and customers worldwide. The AI (automatic WhatsApp
replies and DRAIVA) previously had no reliable concept of "now," "today,"
"tomorrow morning," or a customer's local daypart, and nothing enforced that a
company's operational timezone and a customer's personal timezone are
different, independently-tracked things.

## Decision

- **Two separate timezone concepts, never conflated.** `companies.timezone`
  (already existed, migration 2) is the business's operational timezone.
  `contacts.timezone` (new, migration 14, nullable) is one customer's personal
  timezone, known only when explicitly set by staff. A customer's timezone is
  never inferred from their WhatsApp phone number, browser locale, IP,
  company location, or any other heuristic — `null` is a real, first-class
  "unknown" state, not a loading placeholder.
- **IANA identifiers only.** Both columns store IANA timezone identifiers
  (`Asia/Kolkata`, not `UTC+5:30`) so DST and historical/future rule changes
  resolve automatically through the runtime's own `Intl`/tzdata, never a
  hand-maintained offset table. `packages/core/src/timezone.ts`'s
  `isValidIanaTimezone`/`normalizeTimezone` explicitly reject bare numeric
  offsets even though some `Intl` implementations can technically resolve
  them.
- **Pure core utilities.** `packages/core/src/timezone.ts` computes a single
  timezone's local date/time/day-of-week/daypart/UTC-offset/today/tomorrow/
  yesterday from an injected `now: Date` (never a module-scope clock).
  `packages/core/src/temporalContext.ts`'s `resolveConversationTemporalContext`
  combines a company timezone and a customer timezone into one
  `ConversationTemporalContext`, applying the resolution policy below. Neither
  module knows about Supabase, tenants, or HTTP.
- **Resolution policy.** Company: use the stored valid timezone; if missing or
  invalid, compute using UTC as a technical fallback only — `company.timezone`
  itself still reports `null` so callers can surface the configuration gap
  rather than presenting UTC as the business's real local time. Customer: use
  the stored valid timezone, or leave it explicitly `UNKNOWN`. Customer
  timezone never falls back to company timezone.
- **Same resolver everywhere.** The automatic WhatsApp reply pipeline
  (`apps/workers/message-consumer`, `apps/workers/voice-consumer` — text and
  transcribed voice both go through the same `AiGenerationInput.temporal`) and
  DRAIVA (`apps/web/lib/repositories/chatAgentContext.ts` →
  `ChatAgentInput.temporal`) call the identical resolver with values fetched
  at request time, computed with `now: new Date()` at request execution —
  never cached, never module-scope.
- **One shared prompt block.** `packages/ai/src/prompt/temporalPromptBlock.ts`
  renders the `CURRENT TEMPORAL CONTEXT` block and the temporal system rules
  used by both the main WhatsApp system prompt
  (`packages/ai/src/prompt/buildSystemPrompt.ts`) and DRAIVA's
  (`packages/ai/src/chatAgent/systemPrompt.ts`), so daypart boundaries and
  unknown-customer behavior can never drift between the two prompts. DRAIVA's
  prompt additionally states the staff-vs-customer perspective distinction:
  a customer's own relative-time phrases are interpreted in customer time; a
  staff member's own operational question defaults to business time.
- **Daypart boundaries** (`resolveDaypart` in `timezone.ts`, centralized, not
  duplicated in any prompt or component): morning 05:00–11:59, afternoon
  12:00–16:59, evening 17:00–20:59, night 21:00–04:59.
- **Unknown-customer AI behavior.** When customer timezone is unknown, the
  model must not guess a daypart, must avoid unearned time-of-day greetings,
  and must ask for the customer's timezone only when a relative-time request
  genuinely can't be fulfilled without it. Understanding "tomorrow morning"
  is never authorization to autonomously promise a callback/meeting — the
  existing `requiresHuman`/handover safety rules are unchanged and still
  govern whether anything was actually committed.
- **Translate preserves scheduling semantics.** The Translate action
  (`packages/ai/src/chatAgent/actions.ts`) explicitly preserves dates, times,
  timezone names, and UTC offsets verbatim, and translates relative phrases
  ("tomorrow morning") into their natural target-language equivalent without
  ever reinterpreting them into a more specific date/time.
- **Two narrow RPCs**, matching the existing `SECURITY DEFINER` /
  `set search_path = ''` / fixed-exception-vocabulary / minimal-projection
  pattern established by migration 12's Human Handover RPCs:
  `update_company_timezone` (requires `settings.manage`, updates only the
  caller's own active company) and `update_contact_timezone` (requires
  `conversations.reply`, derives the target company from the contact row
  itself so a client-supplied company id is never trusted, and accepts
  `null` to explicitly restore "unknown"). Both validate the timezone against
  Postgres's own `pg_timezone_names` server-side, as defense in depth
  alongside the application-layer `Intl`-based check.
- **Existing stored values are never touched.** No bulk backfill, no
  country-based guess, no phone-prefix inference. `companies.timezone`'s
  schema-level default (`'Asia/Kolkata'`, from migration 2, predating this
  ADR) is left as-is for existing rows — this ADR does not alter migration
  history — but every new prompt/UI path treats a missing/invalid value as a
  real configuration gap to surface, never a silent assumption.

## Consequences

- The AI can correctly reason about "tomorrow morning," "tonight," and
  business-vs-customer local time for any IANA timezone worldwide, including
  half-hour (`Asia/Kolkata`) and quarter-hour (`Asia/Kathmandu`) offsets and
  DST-observing regions, without a maintenance burden as DST rules change.
- Adding a genuinely new temporal capability (e.g. surfacing "tomorrow" in a
  new UI element) means calling the existing pure utilities, not building a
  new date/timezone implementation.
- `companies.timezone`'s pre-existing `'Asia/Kolkata'` column default remains
  a known, intentionally out-of-scope gap: it affects only brand-new company
  rows created without an explicit timezone, and changing a schema default is
  a separate, narrower decision than this ADR's scope covers.
