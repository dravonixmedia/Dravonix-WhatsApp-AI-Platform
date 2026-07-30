# ADR-0001: Multi-tenant strategy

## Status

Accepted

## Context

Dravonix WhatsApp AI Platform must serve many client companies from one codebase and
one database, with a hard guarantee that no company can ever read, infer, or affect
another company's data — messages, media, knowledge, leads, billing, or staff.

Options considered:

1. **Database-per-tenant** — strongest isolation, highest operational cost; overkill
   for the current scale and explicitly deferred by the Master Prompt to "future
   enterprise clients who purchase dedicated infrastructure."
2. **Schema-per-tenant** — better isolation than shared tables, but migrations and
   RLS tooling in Supabase are built around shared schemas with row-level policies;
   schema-per-tenant would fight the platform rather than use it.
3. **Shared tables + `company_id` + Postgres Row Level Security (RLS)** — chosen.

## Decision

Use shared tables with a mandatory, immutable `company_id` (or equivalent) column on
every tenant-owned table, enforced by:

- **Postgres RLS** on every tenant-owned table, driven by a `current_company_ids()`
  helper function that resolves the authenticated user's active company memberships
  from `company_members` (not solely from JWT claims, since membership can change
  without a token refresh — see policy design in `DATABASE.md`).
- **Server-side authorization** in `apps/api` and `apps/workers/*`: every domain
  service function takes an explicit tenant context object; there is no "query
  everything" code path.
- **Storage path prefixing**: `companies/{company_id}/...` for every object in R2 or
  Supabase Storage; storage policies deny cross-prefix access.
- **Queue payload validation**: every job payload embeds `company_id`; consumers
  re-validate it against the referenced entities before processing (a poisoned or
  malformed job cannot cross a tenant boundary).
- **Cache/log keys**: any cache key or log line that touches tenant data is prefixed
  or tagged with `company_id`.
- **Automated isolation tests**: SQL-level RLS tests (`supabase/tests`) and
  application-level tests assert Company A cannot read/write/export Company B's
  contacts, messages, media, knowledge, leads, billing, or staff.

Platform-level roles (`super_admin`, `platform_support`, `platform_billing_admin`)
bypass tenant RLS only through an explicit, audited service-role path — never through
a blanket "admin sees everything" RLS clause — so every cross-tenant read by platform
staff is logged in `audit_logs` and, for support access, further gated by
`support_access_sessions` (time-limited, visibly banner'd, recorded).

## Consequences

- One codebase, one Postgres database, one deployment — matches the Master Prompt's
  requirement to avoid per-company infrastructure by default.
- RLS policies must be written and tested carefully; every new tenant-owned table
  requires a corresponding policy and isolation test as part of its migration (see
  `DATABASE.md` checklist).
- A future enterprise client requiring dedicated infrastructure can be served by
  standing up a second deployment of the same codebase pointed at its own Supabase
  project — no application rewrite required.
