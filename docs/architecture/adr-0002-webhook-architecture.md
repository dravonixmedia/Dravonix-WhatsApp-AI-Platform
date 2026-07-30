# ADR-0002: WhatsApp webhook architecture

## Status

Accepted

## Context

Meta requires webhook endpoints to (a) respond to a GET verification challenge, (b)
accept POST event deliveries signed with `X-Hub-Signature-256`, and (c) respond
quickly — slow or failing responses cause Meta to retry, which can produce duplicate
processing if not handled carefully. Voice and AI processing are too slow to run
inline within the webhook request.

## Decision

- `apps/api` exposes `GET /webhooks/whatsapp` for the verification handshake
  (`hub.mode`, `hub.verify_token`, `hub.challenge`) checked against
  `META_VERIFY_TOKEN`, and `POST /webhooks/whatsapp` for event delivery.
- Every POST is verified with HMAC-SHA256 over the raw body using `META_APP_SECRET`
  before any parsing (`packages/whatsapp/src/signature.ts`). Invalid signatures are
  rejected with 401 and never enqueued.
- The route does the minimum synchronous work: verify signature → parse envelope →
  resolve `phone_number_id` → company → write a row to `webhook_events` (idempotency
  key = provider event/message ID) → enqueue a job to Cloudflare Queues → return
  `200 OK`. Target latency is well under Meta's timeout.
- All AI, knowledge, speech and WhatsApp-send work happens in `apps/workers/*`
  queue consumers, decoupled from the webhook request/response cycle.
- Idempotency is enforced at two levels: the webhook layer (unique constraint on
  `webhook_events.provider_event_id`) and the message layer (unique constraint on
  `messages.provider_message_id`), so Meta's at-least-once retry semantics never
  produce a duplicate customer-visible reply.
- Status callbacks (sent/delivered/read/failed) update `message_status_events`
  keyed by `provider_message_id`; out-of-order delivery is handled by keeping every
  status event (not just the latest) and deriving current status by
  rank(sent < delivered < read) with failure overriding, rather than blind
  overwrite.
- Unknown `phone_number_id` values (not mapped to any company) are stored with a
  distinct status for admin visibility, never silently discarded and never routed
  to a default tenant.

## Consequences

- The webhook endpoint has no dependency on Anthropic/Google/Razorpay availability —
  it only depends on the database and the queue, both of which are fast and local
  to the platform.
- Consumers must re-check company/subscription state themselves (they cannot trust
  that state hasn't changed between enqueue and processing) — this is also required
  independently by ADR-0006 (billing state machine) for suspension enforcement.
- Retry-safety must be tested explicitly: duplicate webhook delivery, out-of-order
  status events, and consumer retry must all be covered by fixtures in
  `packages/whatsapp/test` and `apps/workers/message-consumer/test`.
