# RAZORPAY_TEST_SETUP.md

## 1. Create a Razorpay account and switch to Test Mode

1. Sign up at https://razorpay.com.
2. In the Dashboard, toggle **Test Mode** (top-right). All work in Stage A
   happens in test mode — no real money moves.
3. Settings → API Keys → generate a **Test** key ID/secret pair.

## 2. Configure environment variables

```
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
RAZORPAY_MODE=test
```

`packages/config/src/env.ts` refuses to start with `RAZORPAY_MODE=live` in
`APP_ENV=production` unless `RAZORPAY_KEY_SECRET` is also set — this is a
guardrail, not a substitute for actually switching Razorpay's own dashboard
out of test mode when you're ready for Stage B.

## 3. Configure the webhook

Dashboard → Settings → Webhooks → Add New Webhook, pointing at
`https://<your-api-domain>/webhooks/razorpay` (once that route is added —
tracked in `TASKS.md`), subscribed to at least:

- `subscription.authenticated`, `subscription.activated`, `subscription.charged`
- `subscription.pending`, `subscription.halted`
- `subscription.paused`, `subscription.resumed`
- `subscription.cancelled`, `subscription.completed`
- `payment.failed`

Copy the webhook secret shown into `RAZORPAY_WEBHOOK_SECRET`.

## How events map to internal state

`packages/billing/src/providers/razorpay/eventMapper.ts` is the **only** place
in the codebase that understands Razorpay's event vocabulary — every event
above maps to one of the internal `SubscriptionEvent`s consumed by
`packages/billing/src/stateMachine.ts` (see ADR-0006). Notably, Razorpay's own
`subscription.halted` is treated as another payment-failure signal rather than
an authoritative "suspend now" instruction — the platform's own configurable
grace period (`packages/billing/src/gracePeriod.ts`) decides when a company
actually moves to `suspended`.

`packages/billing/src/providers/razorpay/webhookSignature.ts` verifies
`X-Razorpay-Signature` (a raw hex HMAC-SHA256 digest of the body) before any
event is processed — tested with a genuine tampered-body rejection case in
`packages/billing/test/razorpay.test.ts`.

## Testing a subscription end to end

1. Create a test customer and subscription via the Razorpay API or Dashboard
   test tools, referencing one of the seeded `plan_versions` (see
   `supabase/seed/001_plans.sql`) mapped to a Razorpay Plan ID you create in
   test mode.
2. Use Razorpay's test card numbers (published in their docs) to simulate a
   successful or failing payment.
3. Confirm the corresponding `subscription_events` row and `subscriptions.state`
   transition appear once the webhook consumer is wired (`apps/workers/billing-consumer`,
   tracked in `TASKS.md`).

## Manual payments (bank transfer / UPI)

For companies paying outside Razorpay, `packages/billing/src/manualPayments.ts`
enforces that only a `platform_billing_admin` or `super_admin` may approve a
submission, and never the same user who submitted it — see
`packages/billing/test/manualPayments.test.ts`.
