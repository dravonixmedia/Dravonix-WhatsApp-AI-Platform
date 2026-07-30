# ADR-0006: Billing state machine

## Status

Accepted

## Context

Razorpay (and any future payment provider) exposes its own subscription/payment
states. Coupling the platform's suspension/entitlement logic directly to
provider-specific states would spread provider knowledge throughout the app and
make provider migration or manual-payment support (bank transfer/UPI) hard to
reason about consistently.

## Decision

- `packages/billing/src/stateMachine.ts` defines an internal, deterministic state
  machine over platform-level subscription states:
  `onboarding → trial → active → payment_due → grace_period → suspended`, plus
  side states `cancel_at_period_end`, `cancelled`, `manually_suspended`, `closed`.
  Transitions are an explicit table of `(fromState, event) → toState`; any event not
  in the table for the current state is rejected (throws
  `InvalidStateTransitionError`) rather than silently coerced.
- The subscription row stores both the internal `state` and the raw provider status
  string (`provider_status`) for observability, but **only** the internal state
  drives entitlement checks anywhere in the app.
- Razorpay webhook events (authenticated, activated, charged, pending, halted,
  paused, resumed, cancelled, completed, payment failed) are translated to state
  machine events by `packages/billing/src/providers/razorpay/eventMapper.ts` — a
  single, isolated mapping function. Manual payment approval
  (`packages/billing/src/manualPayments.ts`) drives the same state machine through
  the same events, so Razorpay and manual payments are indistinguishable to the
  rest of the app once mapped.
- Grace period length is a configurable value on the plan/company (default 5 days,
  seeded, never hard-coded in business logic) read at the moment grace period
  starts, so changing the default later doesn't retroactively change an
  in-progress grace period.
- A single guard, `packages/billing/src/entitlementGuard.ts`
  (`assertCompanyMayUseProvider(companyId, capability)`), is called at the top of
  every chargeable operation (Claude call, STT, TTS, WhatsApp send, knowledge
  ingestion). It checks: company status, subscription state, plan entitlement for
  the requested capability, usage-limit headroom, and manual super-admin overrides,
  in that order, and throws a typed `EntitlementDeniedError` with a reason if any
  check fails. Callers never re-implement this logic themselves.
- State transitions are recorded to `subscription_events` (append-only) so the full
  history — including every override — is auditable.

## Consequences

- Adding Stripe or another provider later means writing one event-mapper module;
  the state machine, entitlement guard, and every call site are untouched.
- The state machine is fully unit-testable without any network calls — every valid
  and invalid transition is enumerable and tested
  (`packages/billing/test/stateMachine.test.ts`).
- The entitlement guard becomes the single place that must be correct for the
  Master Prompt's hard suspension requirement ("no Claude, STT or TTS calls for a
  suspended company"); it is covered by a dedicated integration test that spies on
  the AI/speech/WhatsApp provider mocks and asserts zero invocations for a
  suspended company (`apps/workers/message-consumer/test/suspension.test.ts`).
