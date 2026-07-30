# TESTING.md — Dravonix WhatsApp AI Platform

## Running the suites

```bash
pnpm install
pnpm lint            # eslint across the workspace
pnpm format:check    # prettier --check
pnpm typecheck        # each package's own tsc --noEmit (apps/web included)
pnpm test             # vitest across every packages/*, apps/api, apps/workers/* test dir
pnpm test:db          # RLS tenant-isolation suite against a scratch Postgres DB
```

`pnpm test:db` requires a local Postgres 16 with the `vector` extension (see
`supabase/tests/README.md` for exact setup) or `TEST_DATABASE_ADMIN_URL`
pointing at one; CI runs it against a `pgvector/pgvector:pg16` service
container automatically.

As of the last commit in this session: **227 vitest tests** across 36 test
files, plus **20 executable SQL assertions** in the RLS suite, all passing.

## What's covered where

| Area                                | Location                                                                    | Notable scenarios                                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env validation                      | `packages/config/test/env.test.ts`                                          | production guardrails (dev tenant selector, live Razorpay key requirement)                                                                                                                                                                                                         |
| Branding                            | `packages/config/test/branding.test.ts`                                     | default values, page-title helper                                                                                                                                                                                                                                                  |
| Conversation/handover state machine | `packages/core/test/conversationStateMachine.test.ts`                       | every valid transition; invalid transitions rejected; AI-reply suppression per state                                                                                                                                                                                               |
| HMAC crypto                         | `packages/core/test/crypto.test.ts`                                         | known test vector, timing-safe comparison                                                                                                                                                                                                                                          |
| Queue harness                       | `packages/core/test/queue.test.ts`                                          | retry + dead-letter behavior                                                                                                                                                                                                                                                       |
| Tenant context/permissions          | `packages/tenant/test/context.test.ts`                                      | membership resolution, permission denial, cross-company isolation, platform-staff override                                                                                                                                                                                         |
| Auth session                        | `packages/auth/test/session.test.ts`                                        | missing/invalid/valid bearer tokens                                                                                                                                                                                                                                                |
| **Database RLS**                    | `supabase/tests/rls_tenant_isolation.sql` (run via `supabase/tests/run.sh`) | Company A cannot read Company B's contacts/messages/knowledge/leads/invoices; `billing_viewer` cannot read messages; `agent` cannot read invoices; disabled member loses access; anonymous caller sees nothing; platform support staff can read across tenants                     |
| WhatsApp webhook                    | `packages/whatsapp/test/*`, `apps/api/test/*`                               | valid/invalid signature, verification handshake, text/audio/status parsing, unsupported message types, duplicate delivery producing no duplicate reply, unrouted phone numbers, out-of-order status reconciliation                                                                 |
| AI response engine                  | `packages/ai/test/*`                                                        | valid/invalid structured output, one repair attempt, safe fallback on repeated failure, ungrounded pricing/hours claims forced to `requiresHuman`, lead-update merge never re-asking known fields, prompt content (safety rules, restricted topics, no-invented-facts instruction) |
| Speech                              | `packages/speech/test/*`                                                    | reply-mode precedence (all downgrade paths), a **real RSA sign/verify round-trip** of the from-scratch Google OAuth2 JWT implementation, deterministic mock STT/TTS                                                                                                                |
| Knowledge                           | `packages/knowledge/test/*`                                                 | cross-tenant retrieval isolation, relevance threshold filtering, file type/size validation, chunking, plaintext/CSV extraction                                                                                                                                                     |
| Billing state machine               | `packages/billing/test/stateMachine.test.ts`                                | every valid/invalid transition, service-blocked state set                                                                                                                                                                                                                          |
| Entitlement guard                   | `packages/billing/test/entitlementGuard.test.ts`                            | **suspended company triggers zero Claude/STT/TTS/WhatsApp-send calls** (acceptance criteria #22), grace period still allows service, plan-missing-feature and usage-limit denials                                                                                                  |
| Manual payments                     | `packages/billing/test/manualPayments.test.ts`                              | billing-admin-only approval, no self-approval                                                                                                                                                                                                                                      |
| Razorpay adapter                    | `packages/billing/test/razorpay.test.ts`                                    | event-to-state-machine mapping, signature verification incl. tampered-body rejection                                                                                                                                                                                               |
| Notifications                       | `packages/notifications/test/notification.test.ts`                          | billing categories can never target a customer contact                                                                                                                                                                                                                             |
| Observability                       | `packages/observability/test/*`                                             | secret redaction (top-level, nested, array, inline Bearer), structured log shape, context merging via `child()`                                                                                                                                                                    |
| Storage                             | `packages/storage/test/*`                                                   | path-traversal rejection, per-company key isolation, retention expiry selection                                                                                                                                                                                                    |
| **End-to-end webhook wiring**       | `apps/api/test/app.test.ts`, `apps/api/test/whatsappWebhookHandler.test.ts` | full Hono request → signature verify → route → dedupe → persist → enqueue, exercised through real HTTP requests via Hono's `app.request()`                                                                                                                                         |
| **End-to-end message processing**   | `apps/workers/message-consumer/test/processMessageJob.test.ts`              | full pipeline (entitlement guard → conversation-state check → knowledge retrieval → AI → WhatsApp send → lead/handover updates); **suspended-company proof repeated at the consumer level**, and a human-controlled conversation never receives an automatic AI reply              |

## Fixtures

Representative Meta webhook payloads (text, audio, delivered status, failed
status) live in `packages/whatsapp/test/fixtures/*.json`, modeled on Meta's
documented webhook object shape.

## What is intentionally not run in this environment

- **Browser/E2E tests** (Playwright/Cypress against a running deployment) —
  no deployed instance exists in this development session.
- **Load tests** — require a deployed environment.
- **Real Malayalam/Hindi/Arabic speech accuracy validation** — requires
  physical audio samples and a live Google Cloud Speech credential.
- **Live Razorpay/Meta/Anthropic integration tests** — every provider has a
  mock adapter used instead; integration against the real API requires real
  credentials, which are documented in the `*_SETUP.md` files but not present
  in this environment.

These are listed honestly in `TASKS.md`'s "Outstanding limitations" section
rather than silently assumed complete.
