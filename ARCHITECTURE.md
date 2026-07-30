# ARCHITECTURE.md — Dravonix WhatsApp AI Platform

This file is a short index. The full system diagram and request-flow
walkthrough live in **`docs/architecture/overview.md`**; the reasoning behind
every major structural decision is recorded as an ADR in `docs/architecture/`:

| ADR                                                                | Decision                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [0001](docs/architecture/adr-0001-multi-tenant-strategy.md)        | Shared tables + `company_id` + Postgres RLS, not database/schema-per-tenant              |
| [0002](docs/architecture/adr-0002-webhook-architecture.md)         | WhatsApp webhook: verify → ack fast → queue; idempotency by provider message/event ID    |
| [0003](docs/architecture/adr-0003-queue-architecture.md)           | Cloudflare Queues per consumer domain, versioned payload schemas, dead-letter visibility |
| [0004](docs/architecture/adr-0004-ai-provider-architecture.md)     | AI behind a provider interface; structured output + one repair attempt + safe fallback   |
| [0005](docs/architecture/adr-0005-speech-provider-architecture.md) | STT/TTS behind a provider interface; OGG/Opus direct, no in-Worker FFmpeg                |
| [0006](docs/architecture/adr-0006-billing-state-machine.md)        | Internal subscription state machine independent of any payment provider's vocabulary     |
| [0007](docs/architecture/adr-0007-storage-strategy.md)             | Storage behind a provider interface; tenant-scoped keys built by one function only       |
| [0008](docs/architecture/adr-0008-centralized-branding.md)         | One branding config object; business-logic packages never depend on it                   |

## One-paragraph summary

`apps/api` (Hono, Cloudflare Workers) terminates WhatsApp and Razorpay webhooks,
verifies signatures, resolves the owning company, deduplicates, persists, and
enqueues work to Cloudflare Queues — it does no AI, speech, or payment-provider
work itself. `apps/workers/*` consumers do that work, re-validating the
company's entitlement (`packages/billing`'s `assertCompanyMayUseProvider`) and
the conversation's state (`packages/core`'s conversation state machine) before
calling Claude (`packages/ai`), Google Speech (`packages/speech`), or sending a
WhatsApp reply (`packages/whatsapp`). Every tenant-owned table in Supabase
Postgres carries `company_id` and Row Level Security; `apps/web` is a Next.js
dashboard reading the same centralized branding config
(`packages/config`) that every other surface uses.

## Where to find things

- **Tenant isolation enforcement points**: `docs/architecture/overview.md`
  ("Multi-tenancy enforcement points" section) and `packages/tenant`.
- **The full database schema**: `DATABASE.md` + `supabase/migrations/*.sql`.
- **How suspension blocks paid providers**: `packages/billing/src/entitlementGuard.ts`
  and `apps/workers/message-consumer/src/processMessageJob.ts`.
- **How the AI response is validated and made safe**: `packages/ai/src/orchestrate.ts`
  and `packages/ai/src/safety.ts`.
