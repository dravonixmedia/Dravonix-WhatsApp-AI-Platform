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

- [x] `packages/speech`: STT/TTS provider interfaces (`SpeechToTextProvider`,
      `TextToSpeechProvider`), mock adapters
- [x] Google Cloud Speech-to-Text/Text-to-Speech REST adapters (OGG/Opus
      output directly) and a from-scratch OAuth2 service-account JWT (RS256)
      signer on Web Crypto, cryptographically tested. Remain available as an
      alternative implementation; no longer the default provider (see below).
- [x] `WhisperSpeechToTextProvider` (OpenAI) — briefly the default STT
      provider after live testing found Google's API required guessing an
      Ogg Opus sample rate that didn't match real WhatsApp audio (confirmed
      24000 Hz via direct header inspection, not the commonly-assumed 16000
      or 48000). Superseded by ElevenLabs below; remains available.
- [x] `ElevenLabsSpeechToTextProvider` / `ElevenLabsTextToSpeechProvider` —
      current default for both STT and TTS (`apps/workers/voice-consumer`'s
      composition root), chosen for Ogg/Opus support with no sample-rate
      guessing and better colloquial/code-switched regional speech handling
      than Google's standard model. See
      `docs/architecture/adr-0005-speech-provider-architecture.md`.
- [x] Reply-mode resolution implementing the full Master Prompt section 4
      precedence chain (contact preference overrides company default unless
      voice is disabled/plan-gated/suspended/over-limit/provider-unavailable)
- [x] `packages/storage`: tenant-scoped key builder (path-traversal rejected),
      R2 adapter, in-memory mock adapter, retention-expiry helpers
- [x] **apps/workers/voice-consumer** (audio download → STT → AI → TTS →
      WhatsApp voice send) — built, deployed, and exercised end to end
      against the live Meta test number and a live Anthropic key during this
      integration's debugging; entitlement/suspension checks (ADR-0006) gate
      every STT/TTS/Claude call the same way message-consumer does.
- [ ] Real multi-language/accent sample-audio accuracy test against
      ElevenLabs — one real Malayalam voice note has been tested; the fuller
      matrix (English/Hindi/Arabic, multiple speakers/accents/conditions) has
      **not** been run. Tracked as an outstanding limitation.
- [ ] Dashboard voice settings UI (provider/model/voice selection, per-company
      voice usage, connection test) and dedicated ElevenLabs usage-metering
      records beyond the existing `media_files`-based entitlement usage
      calculation — not built; a separate, larger piece of work from this
      integration.

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

1. **Live credentials**: Meta WABA/phone number, Anthropic API key, and a real
   Supabase project are configured and working in production. Google Cloud
   service account credentials and Razorpay live keys are still absent.
   Every provider has a tested mock adapter regardless; switching to a real
   one is a configuration change, not a code change, documented in each
   `*_SETUP.md` file.
2. **Malayalam/Hindi/Arabic voice accuracy is only partially validated** —
   one real Malayalam voice note has been transcribed successfully via
   ElevenLabs; Hindi, Arabic, and a fuller matrix of speakers/accents/audio
   conditions have not been tested.
3. **`apps/api`, `voice-consumer`, and `message-consumer` are deployed to
   Cloudflare** (dravonixapp, dravonix-audio, dravonix-whatsapp-ai-platform)
   and have processed real messages against the live Meta test number.
   `billing-consumer`, `knowledge-consumer`, and `notification-consumer` are
   not yet built or deployed — the packages they would call
   (`packages/billing`, `packages/knowledge`, `packages/notifications`) are
   built and independently tested. Cloudflare Workers Builds' auto-provisioned
   CI deploy token cannot bind Queues (a confirmed platform limitation, hit
   repeatedly); this is now fixed by deploying through
   `.github/workflows/ci.yml`'s `deploy` job with a custom-scoped
   `CLOUDFLARE_API_TOKEN` instead (see `DEPLOYMENT.md`), which does have
   Queues permission. Workers Builds' git integration should be disabled for
   these three services (one-time dashboard action) so it stops deploying
   alongside this pipeline and re-wiping bindings.
4. **apps/api has only the WhatsApp webhook and health routes.** No REST API
   exists yet for conversations, leads, knowledge, billing, team management,
   or super-admin actions — these are the next concrete step for anyone
   continuing this work, and the domain logic each would call already exists
   in `packages/*`.
5. **apps/web is a UI shell**, not a data-connected dashboard: every page
   beyond login/branding renders a documented placeholder or empty state
   rather than live data, because there is no deployed API for it to call.
   Voice settings (provider/model/voice selection, per-company usage,
   connection test) are part of this gap, not built yet.
6. **No browser/E2E tests, no load tests, no third-party security audit.**
7. **Meta Embedded Signup is designed for but not implemented**, pending a
   Meta Tech Provider/Solution Partner account.
8. **CI (`.github/workflows/ci.yml`'s `deploy` job) deploys `apps/api`,
   `voice-consumer`, and `message-consumer` to Cloudflare on every push to
   the current working branch**, gated on lint/typecheck/test passing first,
   using a custom-scoped `CLOUDFLARE_API_TOKEN` that can manage Queues (see
   item 3 and `DEPLOYMENT.md`). Requires the `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` repository secrets to be set, and Workers Builds'
   git integration disabled for these three services, before it's fully
   effective. The deploy job's branch condition should be revisited once a
   real branching/release strategy is settled on.
