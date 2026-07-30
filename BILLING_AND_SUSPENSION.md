# BILLING_AND_SUSPENSION.md

## Three separate charges (Master Prompt section 19)

1. **One-time implementation/service charge** (`service_charges` table) —
   mandatory professional-service fee covering onboarding, WhatsApp setup,
   chatbot customization, knowledge-base setup, testing, deployment, and
   initial support. Independent of the recurring subscription. Statuses:
   `not_created → pending → partially_paid | paid | waived | refunded | cancelled`.
   A company may not move to production `active` status until this is `paid`,
   `waived`, or a super-admin records an override (auditable — see
   `subscription_events.is_manual_override` / `audit_logs`).
2. **Monthly subscription** (`subscriptions`/`plan_versions`) — platform
   access, chatbot operation, dashboard, hosting, included usage allowance.
3. **Usage overages** (`usage_events`/`usage_summaries`, `invoice_kind = 'usage_overage'`)
   — WhatsApp messaging, Claude tokens, voice minutes, storage, additional
   numbers/employees/branches beyond plan limits.

## The internal subscription state machine (ADR-0006)

```
onboarding → trial → active → payment_due → grace_period → suspended
                         ↕                                      ↕
                cancel_at_period_end                    (payment recovered → active)
                         ↓
                    cancelled                    (any operational state) → manually_suspended
                                                                                  ↓
                                                                          (reactivate → active)
```

Defined in `packages/billing/src/stateMachine.ts` as an explicit
`(state, event) → state` table (`applySubscriptionEvent`); any event not valid
for the current state throws `InvalidStateTransitionError` rather than being
silently coerced — tested exhaustively in
`packages/billing/test/stateMachine.test.ts`.

**Only these ten states ever gate application behavior.** Razorpay's own
status strings are stored in `subscriptions.provider_status` for observability
only (`packages/billing/src/providers/razorpay/eventMapper.ts` is the sole
translation point) — never read directly by any entitlement check.

## Grace period

Length is per plan-version (`plan_versions.grace_period_days`, default 5
days seeded, 7 for Professional — see `supabase/seed/001_plans.sql`), captured
onto the subscription the moment the grace period _starts_
(`packages/billing/src/gracePeriod.ts`'s `computeGracePeriodEnd`) — a later
change to the platform default does not retroactively shorten/extend an
already-running grace period.

## Suspension enforcement (Master Prompt sections 22-23)

`packages/billing/src/entitlementGuard.ts`'s `assertCompanyMayUseProvider` is
the **single** required check before every chargeable operation:

| Capability                          | Blocked by                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `claude_response`                   | company suspended/manually_suspended/closed, subscription not active, `monthly_messages` limit reached |
| `speech_to_text` / `text_to_speech` | above, plus `voice_enabled` plan/company entitlement, `monthly_voice_minutes` limit                    |
| `whatsapp_send`                     | company/subscription status only                                                                       |
| `knowledge_ingestion`               | above, plus `document_knowledge_base` entitlement                                                      |

`grace_period` and `payment_due` are **not** service-blocked states — per
Master Prompt section 22, service stays active during the grace period.
`suspended`, `manually_suspended`, `cancelled`, and `closed` are.

This is proven with automated tests at two levels: the guard itself
(`packages/billing/test/entitlementGuard.test.ts`) and the actual message
processing pipeline (`apps/workers/message-consumer/test/processMessageJob.test.ts`),
both asserting **zero** calls reach the Claude/STT/TTS/WhatsApp-send mocks for
a suspended company.

## Customer-facing behavior while suspended

The customer is never told the company failed to pay. A neutral fallback
message (`company_settings.static_fallback_message`, default: "Automated
assistance is temporarily unavailable. Our team will respond as soon as
possible.") may be sent, subject to a per-contact cooldown to avoid spam — this
must never itself trigger Claude, STT, or TTS (it's a static string, sent
directly). Wiring this fallback path into `apps/workers/message-consumer` is
tracked in `TASKS.md`.

## Reactivation

A `payment_recovered` event (from a real Razorpay charge or an approved manual
payment) transitions `payment_due`, `grace_period`, or `suspended` back to
`active` — the same event, regardless of source, because
`packages/billing/src/manualPayments.ts` and the Razorpay event mapper both
funnel into the identical state machine (ADR-0006). No separate "unsuspend"
code path exists to fall out of sync with the payment-driven one.

## Manual payments (bank transfer / UPI)

Only a `platform_billing_admin` or `super_admin` may approve a manual payment,
and never the user who submitted it — enforced by
`packages/billing/src/manualPayments.ts`'s `assertMayApproveManualPayment`
(tested in `packages/billing/test/manualPayments.test.ts`).

## Every transition is audited

`subscription_events` is append-only; every transition — automated or manual —
is recorded with `from_state`, `to_state`, the triggering `event`, and
`is_manual_override` for super-admin actions (grace-period extension,
immediate suspension, payment waiver, etc.).
