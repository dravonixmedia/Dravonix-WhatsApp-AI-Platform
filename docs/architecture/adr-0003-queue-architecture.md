# ADR-0003: Queue architecture

## Status

Accepted

## Context

Message processing, voice transcription/synthesis, billing webhook processing,
knowledge ingestion, notifications and retention cleanup are all too slow, too
externally-dependent, or too naturally asynchronous to run inline on a request.
Cloudflare Workers offers Queues (at-least-once, retry with backoff, dead-letter
queues) and Cron Triggers (scheduled invocation) as the native primitives.

## Decision

- One Cloudflare Queue (plus a matching dead-letter queue) per consumer domain:
  `message-consumer`, `voice-consumer`, `billing-consumer`, `knowledge-consumer`,
  `notification-consumer` — mirroring `apps/workers/*`.
- Every job payload is validated against a versioned zod schema
  (`packages/validation`) that always includes: `jobId`, `companyId`,
  `correlationId`, `attempt`, `createdAt`, `idempotencyKey`, `payloadVersion`. A job
  failing schema validation goes straight to the dead-letter queue as a poison
  message — it is never blindly retried against application code that doesn't
  understand its shape.
- Idempotency key uniqueness is enforced in Postgres (a `processed_jobs` style
  unique index scoped by consumer + idempotency key) so retried/duplicated jobs are
  detected and skipped without re-sending a customer reply or double-charging usage.
- Retry policy: Cloudflare Queues' built-in retry with exponential backoff, capped
  at a configurable max attempts (default 5); on exhaustion the message moves to the
  domain's dead-letter queue, visible and retriable from the super-admin dashboard
  (Phase 11) rather than silently dropped.
- Every consumer **re-validates** company/subscription/entitlement state before
  performing chargeable work (Claude, STT, TTS, WhatsApp send) — a job enqueued
  while a company was active must not execute privileged work if the company was
  suspended in the meantime.
- Durable Objects are deliberately **not** used for the MVP; nothing in the current
  design needs strongly-consistent shared mutable state beyond what Postgres
  transactions already provide. This is revisited only if a specific feature (e.g.
  real-time collaborative conversation locking under very high concurrency) proves
  Postgres insufficient.

## Consequences

- Consumers are pure functions of (validated payload) → (domain service call),
  making them independently unit-testable without a real Cloudflare Queues runtime.
- Dead-letter visibility and admin retry (Phase 11) become a required feature, not
  an afterthought, since poison messages are an expected occurrence, not an
  exception.
- Local development and CI run consumers against an in-memory/mock queue harness
  (`packages/core/src/queue`) so tests don't require a live Cloudflare account.
