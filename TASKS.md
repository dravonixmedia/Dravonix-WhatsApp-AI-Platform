# TASKS.md — Dravonix WhatsApp AI Platform

Living, phase-by-phase progress record. Check items as they are completed with
working, tested code (not just scaffolding). This file was corrected once
(this revision) to remove several items that were marked `[x]` aspirationally
early in development before the corresponding code actually existed — every
`[x]` below is backed by code and passing tests you can find at the referenced
path.

Legend: `[x]` done · `[~]` partially done / mocked pending real credentials · `[ ]` not started

## Phase 0 — Repository inspection & planning

- [x] Inspect repository (was empty, no commits)
- [x] `PROJECT_PLAN.md`, `TASKS.md`
- [x] Architecture diagram (`docs/architecture/overview.md`, Mermaid) + `ARCHITECTURE.md` index
- [x] ADRs 0001–0008 (multi-tenant, webhook, queue, AI, speech, billing state
      machine, storage, branding)
- [x] `.env.example` documenting every configuration variable
- [x] Branding configuration (`packages/config/src/branding.ts`)

## Phase 1 — Foundation

- [x] pnpm monorepo layout (`apps/*`, `apps/workers/*`, `packages/*`)
- [x] TypeScript strict mode base config, ESLint, Prettier, Vitest, CI
      (`.github/workflows/ci.yml`, includes a `pgvector` service container for
      the RLS suite)
- [x] Centralized env validation (`packages/config/src/env.ts`)
- [x] `packages/core`: typed error hierarchy, conversation/handover state
      machine, in-memory queue harness, portable Web Crypto HMAC helpers

## Phase 2 — Authentication & multi-tenancy

- [x] Full Supabase schema (9 migrations, `supabase/migrations/`), applied and
      verified against a real local Postgres 16 + pgvector instance with zero
      errors
- [x] Row Level Security on every tenant-owned table, with a 20-assertion
      executable isolation suite (`supabase/tests/rls_tenant_isolation.sql`,
      run via `supabase/tests/run.sh`, wired into CI)
- [x] `packages/tenant`: tenant context resolution, permission checks,
      tenant-isolation assertion helpers, dev tenant selector (Stage A)
- [x] `packages/auth`: bearer-token session verification, combined
      auth+permission guard for API routes
- [~] Dev-only tenant selector: implemented and gated behind
  `APP_ENV=development`; no dashboard UI consumes it yet

## Phase 3 — Meta WhatsApp test-number integration

- [x] Webhook verification handshake (GET challenge) and signature
      verification (HMAC-SHA256 `X-Hub-Signature-256`) — `packages/whatsapp`
- [x] Text/audio/status webhook parsing against a zod schema, with fixtures
      modeled on Meta's documented payload shape
- [x] Phone-number-ID → company routing; unknown numbers stored as
      `unrouted`, never guessed
- [x] Idempotency: webhook-event-level and message-level dedup, both tested
      against duplicate delivery
- [x] `WhatsAppProvider` interface: Graph API adapter (send text/audio,
      media metadata/download/upload) + in-memory mock adapter
- [x] Out-of-order status reconciliation (failed always wins; rank-based
      status resolution)
- [x] **apps/api**: real Hono routes (`GET`/`POST /webhooks/whatsapp`,
      `/health`, `/ready`) wired end to end — verified through actual HTTP
      requests via Hono's `app.request()`, not just unit-level function calls
- [~] Template message management: schema + status enum only
  (`whatsapp_templates`); no template submission flow (needs a real WABA)

## Phase 4 — Claude text chatbot

- [x] `packages/ai`: structured JSON response schema (zod), Anthropic
      provider adapter + mock adapter, prompt builder (company identity,
      safety rules, approved facts, retrieved knowledge, conversation memory)
- [x] Orchestration: generate → validate → one repair attempt → safe static
      fallback, with a monitoring hook; raw/invalid JSON never reaches the
      customer
- [x] Structural safety pass: pricing/hours/availability claims without a
      cited knowledge source are forced to `requiresHuman`
- [x] Lead-update merge logic that never re-asks for already-known fields
- [x] `packages/knowledge`: tenant-scoped retriever (company filter applied
      before ranking — explicit cross-tenant test) + ingestion pipeline
      (file validation, cleaning, chunking, plaintext/CSV extraction)
- [x] **apps/workers/message-consumer**: wires entitlement guard + knowledge
      retrieval + AI orchestration + WhatsApp send + lead/handover updates
      into one real pipeline

## Phase 5 — Voice-note system

- [x] `packages/speech`: STT/TTS provider interfaces, Google Cloud
      Speech-to-Text/Text-to-Speech REST adapters requesting OGG/Opus
      directly, mock adapters
- [x] From-scratch Google OAuth2 service-account JWT (RS256) signer on Web
      Crypto, with a genuine cryptographic sign/verify round-trip test
- [x] Reply-mode resolution implementing the full Master Prompt section 4
      precedence chain (contact preference overrides company default unless
      voice is disabled/plan-gated/suspended/over-limit/provider-unavailable)
- [x] `packages/storage`: tenant-scoped key builder (path-traversal rejected),
      R2 adapter, in-memory mock adapter, retention-expiry helpers
- [ ] **apps/workers/voice-consumer** itself (audio download → STT →
      AI → TTS → WhatsApp voice send, wired the same way message-consumer is)
      — not yet built; the pieces it needs (speech, storage, AI, billing,
      WhatsApp send) all exist and are tested individually
- [ ] Real Malayalam/Hindi/Arabic sample-audio manual accuracy test — requires
      a physical audio sample and a live Google Cloud STT credential; **not
      run in this session**, tracked as an outstanding limitation

## Phase 6 — Inbox & human handover

- [x] Conversation/handover state machine (`packages/core`), fully tested
      (every valid/invalid transition, AI-reply suppression per state)
- [x] `apps/workers/message-consumer` respects the state machine: no
      automatic AI reply while `human_active`/`paused`/etc. (tested)
- [x] RLS write policies for `conversation_notes` (insert) and
      `conversation_assignments` (insert/update), gated by permission
- [ ] apps/api REST routes for assign/note/handover/return-to-AI — not built
- [~] Next.js inbox UI: a page shell with a documented empty state exists
  (`apps/web/app/dashboard/inbox/page.tsx`); no live data, no realtime

## Phase 7 — Knowledge base

- [x] Full knowledge schema + RLS (`knowledge_sources`, `knowledge_documents`,
      `knowledge_chunks` with `pgvector` column + full-text index)
- [x] `packages/knowledge` retriever + ingestion pipeline (see Phase 4)
- [~] Document text extraction: plaintext/CSV implemented; PDF/DOCX parsing
  left as a documented follow-up dependency choice
- [ ] apps/api knowledge test/preview route — not built
- [~] Next.js knowledge UI: page shell only, no live data

## Phase 8 — Leads & analytics

- [x] Leads schema + RLS (`leads`, `lead_fields`, `lead_events`)
- [ ] apps/api leads routes — not built
- [~] Next.js leads UI: page shell only, no live data
- [ ] Usage/analytics dashboard wired to real `usage_summaries` data — not
      built (dashboard overview page shows explicitly-labeled placeholder
      stat cards noting their intended real data source)

## Phase 9 — Billing & service charge

- [x] `packages/billing`: internal subscription state machine (fully tested,
      every transition enumerable), entitlement guard, grace-period helpers
- [x] Full billing schema + RLS: `plans`/`plan_versions`/`plan_entitlements`/
      `company_entitlements`, `subscriptions`/`subscription_events`,
      `invoices`/`invoice_items`, `payments`/`payment_attempts`,
      `service_charges`
- [x] Seed data: Starter/Business/Professional plans with real entitlement
      rows (`supabase/seed/001_plans.sql`), verified applied against Postgres
- [x] Razorpay adapter: event-to-state-machine mapping + webhook signature
      verification (incl. a tampered-body rejection test)
- [x] Manual payment approval rules (billing-admin-only, no self-approval)
- [ ] apps/api billing routes (create subscription, submit/approve manual
      payment, list invoices) — not built
- [ ] **apps/workers/billing-consumer** (Razorpay webhook processing, usage
      aggregation) — not built; the domain logic it would call
      (`packages/billing`) is built and tested
- [~] Next.js billing UI: page shell only, no live data

## Phase 10 — Suspension & reactivation

- [x] Entitlement/suspension guard (`packages/billing/src/entitlementGuard.ts`)
      used at every paid-provider call site in the one consumer that exists
      (`message-consumer`)
- [x] Automated proof, at two levels (package unit test and consumer
      integration test), that a suspended/manually-suspended company triggers
      **zero** Claude/WhatsApp-send calls
- [x] `grace_period` correctly does **not** block service (tested) — only
      `suspended`/`manually_suspended`/`cancelled`/`closed` do
- [ ] Grace-period expiry cron job (the job that transitions `grace_period` →
      `suspended` after the configured period elapses) — not built; the state
      machine transition and grace-period-end computation it would call are
      built and tested
- [ ] Read-only dashboard enforcement for a suspended company — not built (no
      live dashboard data yet to make read-only)

## Phase 11 — Super-admin

- [x] Platform roles modeled separately from company roles
      (`platform_members` vs. `company_members`), with RLS policies already
      granting `is_platform_staff()` cross-tenant read access
- [x] `audit_logs`/`support_access_sessions` schema + RLS
- [x] `packages/observability`'s `recordAuditLog` writer abstraction
- [ ] Any actual super-admin apps/api routes or apps/web pages — not built
- [ ] Audit-log writer wired into any real mutation path — not built (no
      mutating routes exist yet to wire it into)

## Phase 12 — Commercial onboarding readiness

- [x] WhatsApp connection kept behind a provider/schema abstraction
      (`whatsapp_accounts`/`whatsapp_phone_numbers`, `WhatsAppProvider`
      interface) so Stage B requires no core rewrite
- [x] `CLIENT_ONBOARDING.md`, `WHATSAPP_PRODUCTION_SETUP.md`,
      `META_TEST_NUMBER_SETUP.md`
- [ ] Meta Embedded Signup implementation — documented as future work,
      requires an approved Meta Tech Provider/Solution Partner account

## Phase 13 — Hardening & release

- [x] Full documentation set: `README.md`, `ARCHITECTURE.md`, `DATABASE.md`,
      `SECURITY.md`, `TESTING.md`, `DEPLOYMENT.md`, `OPERATIONS.md`,
      `INCIDENT_RESPONSE.md`, `CLIENT_ONBOARDING.md`,
      `BILLING_AND_SUSPENSION.md`, `META_TEST_NUMBER_SETUP.md`,
      `WHATSAPP_PRODUCTION_SETUP.md`, `ANTHROPIC_SETUP.md`,
      `GOOGLE_SPEECH_SETUP.md`, `RAZORPAY_TEST_SETUP.md`,
      `SUPABASE_SETUP.md`, `CLOUDFLARE_SETUP.md`,
      `BRANDING_CONFIGURATION.md`, `.env.example`
- [x] apps/web builds successfully with `next build` (verified in this
      session, all 9 routes statically generated)
- [~] Integration-level tests exist (webhook → queue → consumer, full HTTP
  requests through Hono); no browser/E2E tests (no deployed instance)
- [ ] Load testing — requires a deployed environment
- [ ] Third-party/independent security audit — only internal review
      (`SECURITY.md`) performed

## Outstanding limitations (honest list)

1. **No live external credentials** — Meta WABA/phone number, Anthropic API
   key, Google Cloud service account, Razorpay live keys, and a real Supabase
   project are all absent from this environment. Every provider has a tested
   mock adapter; switching to the real one is a configuration change, not a
   code change, documented in each `*_SETUP.md` file.
2. **Malayalam/Hindi/Arabic voice accuracy is unvalidated** — the Google
   Speech adapter and its from-scratch OAuth2 auth are implemented and
   cryptographically tested, but no real audio sample has been transcribed.
3. **No live deployment** — nothing has been deployed to Cloudflare or a real
   Supabase project from this session. The database schema and RLS _have_
   been verified against a real local Postgres 16 + pgvector instance, which
   is the closest verification possible without cloud provisioning.
4. **Four of five queue consumers are unbuilt**: only
   `apps/workers/message-consumer` exists. `voice-consumer`,
   `billing-consumer`, `knowledge-consumer`, and `notification-consumer` are
   not yet implemented — the packages they would call
   (`packages/speech`, `packages/billing`, `packages/knowledge`,
   `packages/notifications`) are built and independently tested.
5. **apps/api has only the WhatsApp webhook and health routes.** No REST API
   exists yet for conversations, leads, knowledge, billing, team management,
   or super-admin actions — these are the next concrete step for anyone
   continuing this work, and the domain logic each would call already exists
   in `packages/*`.
6. **apps/web is a UI shell**, not a data-connected dashboard: every page
   beyond login/branding renders a documented placeholder or empty state
   rather than live data, because there is no deployed API for it to call.
7. **No browser/E2E tests, no load tests, no third-party security audit.**
8. **Meta Embedded Signup is designed for but not implemented**, pending a
   Meta Tech Provider/Solution Partner account.
9. **No CD pipeline** — CI runs lint/typecheck/test/RLS on every push; nothing
   auto-deploys.
