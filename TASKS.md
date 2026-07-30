# TASKS.md — Dravonix WhatsApp AI Platform

Living, phase-by-phase progress record. Check items as they are completed with
working, tested code (not just scaffolding).

Legend: `[x]` done · `[~]` partially done / mocked pending real credentials · `[ ]` not started

## Phase 0 — Repository inspection & planning

- [x] Inspect repository (was empty, no commits)
- [x] `PROJECT_PLAN.md`
- [x] `TASKS.md`
- [x] Architecture diagram (`docs/architecture/overview.md`, Mermaid)
- [x] ADRs: multi-tenant strategy, webhook architecture, queue architecture, AI
      provider architecture, speech-provider architecture, billing state machine,
      storage strategy, centralized product branding
- [x] Environment variable definitions (`.env.example`)
- [x] Acceptance criteria captured (`PROJECT_PLAN.md`, `README.md`)
- [x] Branding configuration defined (`packages/config`)

## Phase 1 — Foundation

- [x] pnpm monorepo layout (`apps/*`, `apps/workers/*`, `packages/*`)
- [x] TypeScript strict mode base config
- [x] ESLint + Prettier
- [x] Vitest test runner wired at root
- [x] GitHub Actions CI (lint, typecheck, test)
- [x] Centralized env validation (`packages/config/src/env.ts`, zod)
- [x] Centralized branding config (`packages/config/src/branding.ts`)
- [x] `packages/core` shared types/errors/result helpers

## Phase 2 — Authentication & multi-tenancy

- [x] Supabase schema migration: companies, members, roles/permissions
- [x] Row Level Security policies for all tenant-owned tables
- [x] `packages/tenant`: tenant context, membership resolution, permission checks
- [x] `packages/auth`: Supabase Auth server helpers, session guard
- [x] Tenant-isolation SQL tests (`supabase/tests`)
- [~] Dev-only tenant selector (documented; gated behind `APP_ENV=development`)

## Phase 3 — Meta WhatsApp test-number integration

- [x] Webhook verification endpoint (GET challenge)
- [x] Webhook signature verification (HMAC SHA-256 `X-Hub-Signature-256`)
- [x] Text-message webhook parsing & persistence
- [x] Phone-number-ID → company routing
- [x] Idempotency (unique Meta message ID constraint + dedup check)
- [x] `packages/whatsapp` send-text abstraction (Graph API adapter + mock adapter)
- [x] Message status webhook (sent/delivered/read/failed) handling
- [~] Template message management (schema + status tracking only; no live template
  submission without a real WABA)
- [x] Unit/integration tests using representative fixtures

## Phase 4 — Claude text chatbot

- [x] `packages/ai` Anthropic provider adapter + mock adapter
- [x] Structured JSON response schema + zod validation + repair-retry
- [x] Prompt builder assembling company profile, knowledge, conversation memory
- [x] `packages/knowledge` retriever abstraction (Postgres full-text, tenant-scoped)
- [x] Lead-update extraction from structured AI output
- [x] Safe static fallback path
- [x] Usage/token recording hook
- [x] Tests: valid/invalid output, repair, prompt-injection resistance, cross-tenant
      retrieval rejection

## Phase 5 — Voice-note system

- [x] `packages/speech` STT/TTS interfaces
- [x] Google Cloud Speech adapter (uses real API when credentials present)
- [x] Mock STT/TTS adapter for local/dev/test
- [x] Audio webhook parsing, media metadata retrieval abstraction
- [x] Reply-mode resolution (company default × contact preference × entitlements)
- [x] Retention policy config + cleanup job skeleton
- [ ] Real Malayalam sample-audio manual test (requires physical audio sample and a
      live Google Cloud STT credential — **not run in this session**, tracked as an
      outstanding limitation)

## Phase 6 — Inbox & human handover

- [x] Conversation/handover state machine (`packages/core` state machine + tests)
- [x] API routes: assign, note, handover, return-to-AI
- [~] Next.js inbox UI (functional list + conversation view wired to API; no
  realtime subscriptions yet)

## Phase 7 — Knowledge base

- [x] Knowledge source/document/chunk schema + RLS
- [x] Ingestion pipeline skeleton (validate → store → extract → chunk → index)
- [~] Document text extraction for PDF/DOCX (interface + plaintext/CSV implemented;
  PDF/DOCX parsing left as a documented follow-up dependency choice)
- [x] Knowledge test/preview API

## Phase 8 — Leads & analytics

- [x] Leads schema + API
- [~] Analytics/usage dashboard (API + basic UI; charts minimal)

## Phase 9 — Billing & service charge

- [x] `packages/billing`: internal subscription state machine + tests
- [x] Plans/plan-versions/entitlements schema + seed (Starter/Business/Professional)
- [x] Service-charge schema + workflow
- [x] Razorpay adapter (test mode) — order/subscription creation + webhook verify
- [x] Invoices/payments schema
- [x] Usage metering schema + aggregation job skeleton
- [~] Manual payment (bank transfer/UPI) approval workflow (schema + API; UI basic)

## Phase 10 — Suspension & reactivation

- [x] Grace-period cron check job skeleton
- [x] Entitlement/suspension guard used at every paid-provider call site
- [x] Automated test proving suspended company triggers zero Claude/STT/TTS/WhatsApp
      send calls
- [~] Read-only dashboard enforcement (API-level checks done; full UI banner pass
  pending)

## Phase 11 — Super-admin

- [x] Super-admin route guard (platform roles, separate from company roles)
- [x] Company onboarding, suspend/reactivate, plan assignment API
- [x] Audit log schema + writer used across sensitive actions
- [~] Full super-admin UI (core screens present; some listed features are stubs)

## Phase 12 — Commercial onboarding readiness

- [x] WhatsApp connection kept behind provider/onboarding abstraction
- [x] `CLIENT_ONBOARDING.md`, `WHATSAPP_PRODUCTION_SETUP.md`
- [ ] Meta Embedded Signup implementation (documented as future work; requires an
      approved Meta Tech Provider / Solution Partner account — outstanding)

## Phase 13 — Hardening & release

- [x] Core documentation set (see README's Documentation section)
- [~] End-to-end tests (API-level integration tests present; browser E2E not run —
  no live browser target in this container without a deployed instance)
- [ ] Load testing (requires a deployed environment — outstanding)
- [ ] Third-party security audit (outstanding — internal security review only)
- [x] `.env.example`, secrets policy, `SECURITY.md`

## Outstanding limitations (honest list)

1. No real Meta WABA/phone number, Anthropic key, Google Cloud credentials, or
   Razorpay live keys are configured in this environment — all providers run
   against mock/test adapters until real secrets are supplied via environment
   variables in the target deployment.
2. Malayalam/Arabic/Hindi voice transcription is implemented against the Google
   Speech-to-Text adapter interface but has not been validated against real audio
   samples in this session.
3. No live Cloudflare Workers/Pages or Supabase project has been provisioned or
   deployed from this session; `DEPLOYMENT.md` documents the exact steps to do so.
4. Browser-based end-to-end tests and load tests require a running deployed
   instance and are not executed here.
5. Meta Embedded Signup is designed for but not implemented, pending a Meta Tech
   Provider/Solution Partner account.
