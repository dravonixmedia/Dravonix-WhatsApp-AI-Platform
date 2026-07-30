# SECURITY.md — Dravonix WhatsApp AI Platform

## Reporting a vulnerability

Email the address in `packages/config/src/branding.ts` (`platformBrand.supportEmail`,
overridable via `PLATFORM_SUPPORT_EMAIL`). Do not open a public issue for a
suspected vulnerability affecting a live deployment.

## Secrets

- No `.env` file, private key, token, or credential is ever committed. `.gitignore`
  excludes `.env`, `.env.local`, `.env.*.local`. `.env.example` documents every
  variable name with no real values.
- Secrets are provided to `apps/api`/`apps/workers/*` as Cloudflare Worker
  secrets (`wrangler secret put`) or environment bindings, never baked into the
  bundle or logged.
- `packages/observability/src/redact.ts` redacts any field whose key matches
  `token|secret|password|api[_-]?key|access[_-]?key|authorization|credential|private[_-]?key`
  (case-insensitive) and masks inline `Bearer <token>` occurrences, applied to
  every structured log line before it is written (`packages/observability/src/logger.ts`).
  Provider adapters (`GraphApiWhatsAppProvider`, `AnthropicProvider`, the Google
  Speech adapters, the Razorpay adapter) never log the raw access
  token/API key/secret they hold.
- `whatsapp_accounts.encrypted_access_token` is stored encrypted at rest (see
  `ENCRYPTION_KEY` in `.env.example`); the Supabase service-role key and every
  other provider secret are configured as Worker secrets, never as
  `NEXT_PUBLIC_*` variables reachable by the browser bundle.

## Authentication & authorization

- End-user authentication is Supabase Auth. Server-side session verification
  (`packages/auth/src/session.ts`) calls `supabase.auth.getUser(token)` —
  the browser is never trusted to assert its own user ID.
- Every mutating/reading domain operation on tenant data goes through
  `packages/tenant`'s `requirePermission`/`assertResourceBelongsToCompany`,
  which re-derives the caller's membership and permissions live from
  `company_members`/`role_permissions` (not from a cached JWT claim), so a
  disabled member or changed role takes effect immediately.
- Row Level Security (`supabase/migrations/00000000000002_core_tenancy.sql`
  onward) is the database-layer backstop: every tenant-owned table has RLS
  enabled with policies scoped by `has_company_permission()`/`is_platform_staff()`.
  See `supabase/tests/README.md` for the executable isolation test suite.
- Platform staff (`super_admin`, `platform_support`, `platform_billing_admin`)
  are modeled in a table entirely separate from company roles
  (`platform_members` vs. `company_members`); a company role never implies
  platform access and vice versa.

## Webhook security

- Meta WhatsApp webhooks: HMAC-SHA256 signature verification
  (`X-Hub-Signature-256`) over the exact raw body, before any JSON parsing
  (`packages/whatsapp/src/signature.ts`). Invalid signatures are rejected with
  401 and never enqueued.
- Razorpay payment webhooks: HMAC-SHA256 signature verification
  (`X-Razorpay-Signature`) over the raw body (`packages/billing/src/providers/razorpay/webhookSignature.ts`).
  Payment state is never trusted from a frontend redirect/query parameter alone.
- Both webhook sources are deduplicated by a unique `(source, provider_event_id)`
  constraint (`webhook_events`) and by a unique `provider_message_id`
  (`messages`) / `(provider, provider_event_id)` (`payment_attempts`), making
  retried deliveries idempotent.

## Suspension / entitlement enforcement

Every chargeable operation (Claude call, speech-to-text, text-to-speech,
WhatsApp send, knowledge ingestion) is gated by
`packages/billing/src/entitlementGuard.ts`'s `assertCompanyMayUseProvider`,
checked at the point of use inside `apps/workers/*` consumers — not only at
webhook-receipt time, since a company's status can change between enqueue and
processing. `apps/workers/message-consumer/test/processMessageJob.test.ts`
and `packages/billing/test/entitlementGuard.test.ts` both assert zero
provider calls occur for a suspended company.

## Input validation

- Every webhook payload is validated against a zod schema
  (`packages/whatsapp/src/webhookSchema.ts`) before being acted on.
- Every AI response is validated against a zod schema
  (`packages/ai/src/schema.ts`) with a bounded repair-then-fallback path — raw
  or invalid model output is never sent to a customer.
- Knowledge document uploads are validated for MIME type and size before
  ingestion (`packages/knowledge/src/ingestion.ts`).
- Storage keys are constructed exclusively by `packages/storage/src/keys.ts`,
  which rejects path-traversal characters rather than sanitizing them.

## Dependency & CI hygiene

- CI (`.github/workflows/ci.yml`) runs lint, format-check, typecheck, unit
  tests, and the RLS isolation suite (against a `pgvector/pgvector:pg16`
  service container) on every push/PR.
- Run `pnpm audit` (or your preferred SCA tool) before a production release;
  this is not yet automated in CI and is tracked as a follow-up in `TASKS.md`.

## Known limitations at this stage

See `TASKS.md`'s "Outstanding limitations" section — no real production
credentials, deployment, or third-party penetration test have been performed
in this development session.
