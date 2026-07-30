# PROJECT_PLAN.md — Dravonix WhatsApp AI Platform

## 1. Product

**Dravonix WhatsApp AI Platform** (short name: **Dravonix AI**) is a multi-tenant
WhatsApp AI chatbot SaaS platform owned and operated by **Dravonix Media**. It lets
Dravonix Media onboard client companies, each with an isolated workspace, its own
WhatsApp Business number, AI chatbot behaviour, knowledge base, team, billing and
analytics.

This document is the living plan for building the platform. It is derived from the
Master Development Prompt. `TASKS.md` tracks granular, checkbox-level progress.
`docs/architecture/` holds diagrams and ADRs.

## 2. Delivery strategy

Given the size of this system, we build in the phases defined in the Master
Development Prompt (section 34), in order, each phase producing **working code**,
not just scaffolding:

0. Planning & architecture (this phase)
1. Monorepo foundation & tooling
2. Auth & multi-tenancy (Supabase Auth, RLS, roles/permissions)
3. Meta WhatsApp test-number integration (webhook, signature verification, text send)
4. Claude text chatbot (structured output, knowledge grounding, lead extraction)
5. Voice-note system (STT/TTS adapters, OGG/Opus, retention)
6. Inbox & human handover
7. Knowledge base (structured + document ingestion)
8. Leads & analytics
9. Billing & one-time service charge (Razorpay test mode)
10. Suspension & reactivation (grace period state machine)
11. Super-admin dashboard
12. Commercial onboarding readiness (Embedded Signup design, docs)
13. Hardening & release (tests, security review, docs)

## 3. Stage A vs Stage B

- **Stage A (current):** Meta WhatsApp Cloud API **test number**, one seeded demo
  tenant ("Dravonix Media"), Razorpay **test mode**, mock providers wherever a real
  credential is unavailable, all data clearly marked as test/demo data.
- **Stage B (future):** Real client companies connect their own WABA/number via
  Dravonix-assisted onboarding, later Meta Embedded Signup. The architecture keeps
  WhatsApp connection behind a provider/onboarding abstraction so Stage B requires
  no core rewrite — only wiring real credentials and enabling production onboarding
  flows that are already coded as configurable, gated paths.

## 4. Non-negotiable architectural rules

- Every tenant-owned row carries an immutable `company_id`. Enforced by DB RLS,
  server-side authorization, storage path prefixing, queue payload validation, and
  logging context — never by frontend filtering alone.
- All external integrations (WhatsApp, AI, speech, payments, storage, notifications)
  sit behind provider interfaces in `packages/*`, with at least one mock/test
  implementation so the app runs without production credentials.
- Billing uses an internal state machine (`packages/billing`) independent of
  Razorpay-specific states; provider webhooks map into it, they don't drive it
  directly.
- Suspended/unentitled companies are blocked **server-side** before any paid
  provider call (Claude, STT, TTS, WhatsApp send) — verified by dedicated tests.
- Product branding lives in one config (`packages/config/src/branding.ts`) consumed
  everywhere; changing brand values never touches chatbot/billing/tenant logic.

## 5. What "done" looks like for this session

Given the scope (a multi-month enterprise build), this repository will contain, by
the end of active development in this session:

- A working monorepo with strict TypeScript, lint, format, tests, CI.
- A real Postgres schema (Supabase migrations) with RLS covering the full tenant
  model, plans/billing/usage, WhatsApp, conversations, knowledge, and audit logging.
- Working webhook verification + signature verification + idempotent message
  ingestion for the Meta test number, with unit/integration tests using
  representative fixtures.
- A working Claude provider with schema-validated structured output, a knowledge
  retriever abstraction, lead extraction, and a safe-fallback/repair path.
- Speech provider interfaces with a Google adapter and a mock adapter, wired into a
  voice-note processing pipeline.
- A billing package with a deterministic, tested internal subscription state
  machine, a Razorpay test-mode adapter, service-charge records, and usage
  metering.
- A suspension/entitlement guard used by every provider-call site, with an
  automated test proving no paid provider is invoked for a suspended company.
- Minimal but functional Next.js dashboards (client + super-admin) wired to real
  API routes, not static mockups.
- Seed data for the Dravonix Media demo tenant, three plans, and a super-admin
  user, clearly marked as test data.
- The full documentation set listed in section 37 of the Master Prompt.

Outstanding limitations that require real-world resources (a live Meta WABA,
Razorpay production keys, Google Cloud credentials, real Malayalam speech
samples, an actual Cloudflare/Supabase deployment) are explicitly listed at the
bottom of `TASKS.md` and `README.md` rather than silently assumed complete.

## 6. Environments & secrets

No secrets are committed. `.env.example` documents every variable. Where a
credential is unavailable in this environment, the corresponding provider ships a
`mock`/`test` implementation selected by config, and this is called out in
`docs/setup/*` and `TASKS.md`.
