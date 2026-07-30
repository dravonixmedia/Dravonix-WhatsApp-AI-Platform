# Dravonix WhatsApp AI Platform

Multi-tenant WhatsApp AI chatbot SaaS platform, built and operated by **Dravonix
Media**. Client companies get an isolated workspace with their own WhatsApp
number, AI chatbot behaviour, knowledge base, team, billing, and analytics.

> Short name: **Dravonix AI** · See `packages/config/src/branding.ts` for the
> centralized branding configuration referenced throughout this document.

## Status

This repository contains a working, tested monorepo covering the platform's
core backend workflows end to end (webhook ingestion, AI response generation,
tenant isolation, billing/suspension enforcement) plus a minimal dashboard UI.
See **`TASKS.md`** for the authoritative, phase-by-phase progress record and a
full list of outstanding limitations (what still requires real credentials, a
live deployment, or physical audio samples to finish validating).

## Repository layout

```text
apps/
  web/                 Next.js dashboards (client + super-admin)
  api/                 Hono API on Cloudflare Workers: webhooks, REST endpoints
  workers/
    message-consumer/  Inbound text message processing (wired: billing + AI + knowledge + WhatsApp send)
    voice-consumer/     Inbound voice-note processing            (see TASKS.md)
    billing-consumer/   Payment webhook processing, grace-period cron            (see TASKS.md)
    knowledge-consumer/ Document ingestion pipeline                              (see TASKS.md)
    notification-consumer/ Notification delivery                                (see TASKS.md)

packages/
  core            shared types, error hierarchy, state machines, HMAC crypto, in-memory queue harness
  config          centralized branding + validated environment loading
  database        Supabase client factories + hand-maintained row types
  auth            bearer-token session verification + auth+permission guard
  tenant          tenant context resolution, permission checks, dev tenant selector
  whatsapp        webhook signature/parsing/routing, Graph API + mock send adapters
  ai              Claude structured-output engine: schema, prompt builder, safety rules, orchestration
  speech          STT/TTS interfaces, Google adapters (with from-scratch OAuth2 JWT auth), reply-mode logic
  billing         internal subscription state machine, entitlement guard, Razorpay adapter
  knowledge       tenant-scoped retriever + ingestion pipeline
  notifications   notification provider abstraction (billing-category audience guard)
  observability   structured logging with secret redaction, audit-log writer
  storage         tenant-scoped storage key builder, R2 + mock adapters

supabase/
  migrations/     9 SQL migrations: full schema + RLS, applied and verified against a real Postgres instance
  seed/           demo tenant (Dravonix Media), 3 plan templates, super-admin creation instructions
  tests/          executable RLS tenant-isolation test suite (run.sh + support/)

docs/
  architecture/   system overview diagram + 8 ADRs
```

## Quick start (local development)

```bash
pnpm install
cp .env.example .env         # fill in what you have; everything else falls back to a mock provider
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @dravonix/web dev     # Next.js dashboard on http://localhost:3000
```

No real Meta/Anthropic/Google/Razorpay/Supabase credentials are required to run
the test suite or the dashboard shell — every external integration has a mock
adapter selected automatically when its credentials are absent (see
`packages/config/src/env.ts` and each provider package's `providers/mockProvider.ts`).

To exercise the database schema and Row Level Security policies against a real
Postgres instance (no Supabase account needed for this), see
`supabase/tests/README.md`.

## Documentation

| Doc                            | Purpose                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `PROJECT_PLAN.md`              | Delivery strategy, phases, non-negotiable architectural rules       |
| `TASKS.md`                     | Phase-by-phase progress checklist and outstanding limitations       |
| `ARCHITECTURE.md`              | System architecture summary (points into `docs/architecture/`)      |
| `DATABASE.md`                  | Schema catalogue, RLS strategy, "add a new tenant table" checklist  |
| `SECURITY.md`                  | Security controls, secret handling, responsible-disclosure notes    |
| `TESTING.md`                   | Test strategy and how to run every test suite in this repo          |
| `DEPLOYMENT.md`                | Deploying apps/api, apps/workers/*, and apps/web to Cloudflare      |
| `OPERATIONS.md`                | Runbooks: webhook failures, dead-letter retry, usage monitoring     |
| `INCIDENT_RESPONSE.md`         | What to do when something breaks in production                      |
| `CLIENT_ONBOARDING.md`         | Dravonix Media's process for onboarding a new client company        |
| `BILLING_AND_SUSPENSION.md`    | Subscription states, grace period, suspension/reactivation flow     |
| `META_TEST_NUMBER_SETUP.md`    | Stage A: connecting the Meta WhatsApp Cloud API test number         |
| `WHATSAPP_PRODUCTION_SETUP.md` | Stage B: onboarding a real client's WhatsApp Business Account       |
| `ANTHROPIC_SETUP.md`           | Configuring Claude / verifying the model ID                         |
| `GOOGLE_SPEECH_SETUP.md`       | Configuring Google Cloud Speech-to-Text/Text-to-Speech              |
| `RAZORPAY_TEST_SETUP.md`       | Configuring Razorpay in test mode                                   |
| `SUPABASE_SETUP.md`            | Provisioning Supabase, running migrations, creating the super-admin |
| `CLOUDFLARE_SETUP.md`          | Provisioning Workers, Queues, R2, and Pages                         |
| `BRANDING_CONFIGURATION.md`    | How to change product branding without touching business logic      |

## License

Proprietary — © Dravonix Media. Not licensed for redistribution.
