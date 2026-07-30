# DATABASE.md — Dravonix WhatsApp AI Platform

Postgres schema for the platform, delivered as Supabase migrations under
`supabase/migrations/`, applied in filename order. See
`docs/architecture/adr-0001-multi-tenant-strategy.md` for the tenancy model and
`supabase/tests/README.md` for how RLS is verified.

## Migration files

| File                                           | Contents                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00000000000001_extensions.sql`                | `pgcrypto`, `pg_trgm`, `vector`                                                                                                                                                                                                 |
| `00000000000002_core_tenancy.sql`              | `companies`, `company_settings`, `company_branding`, `platform_members`, `company_members`, `permissions`, `role_permissions`, RLS helper functions (`current_company_ids`, `has_company_permission`, `is_platform_staff`, ...) |
| `00000000000003_whatsapp.sql`                  | `whatsapp_accounts`, `whatsapp_phone_numbers`, `whatsapp_templates`                                                                                                                                                             |
| `00000000000004_conversations.sql`             | `contacts`, `contact_preferences`, `conversations`, `conversation_assignments`, `conversation_notes`, `messages`, `message_status_events`, `media_files`, `transcriptions`, `generated_audio`                                   |
| `00000000000005_leads.sql`                     | `leads`, `lead_fields`, `lead_events`                                                                                                                                                                                           |
| `00000000000006_knowledge_and_ai_settings.sql` | `knowledge_sources`, `knowledge_documents`, `knowledge_chunks`, `ai_settings`, `voice_settings`, `handover_rules`                                                                                                               |
| `00000000000007_billing.sql`                   | `plans`, `plan_versions`, `plan_entitlements`, `company_entitlements`, `subscriptions`, `subscription_events`, `invoices`, `invoice_items`, `payments`, `payment_attempts`, `service_charges`                                   |
| `00000000000008_usage_notifications_audit.sql` | `usage_events`, `usage_summaries`, `notifications`, `webhook_events`, `job_failures`, `audit_logs`, `support_access_sessions`                                                                                                   |
| `00000000000009_permission_matrix.sql`         | Seeds `permissions` and `role_permissions` — required for any `has_company_permission()` check to ever return true                                                                                                              |

All nine files have been applied against a real local Postgres 16 + pgvector
instance in this repository's development environment with zero errors (see commit
history); `supabase/tests/run.sh` repeats this from a clean database as part of CI.

## Tenancy & RLS

- Every tenant-owned table has a `company_id uuid not null references companies
(id) on delete cascade`.
- `current_company_ids()`, `has_company_permission()`, and `is_platform_staff()` are
  `SECURITY DEFINER` SQL functions that read live from `company_members` /
  `platform_members` — never from JWT claims — so a disabled member or role change
  takes effect immediately, without waiting for a token refresh.
- RLS is enabled on every tenant-owned table. Read (`SELECT`) policies are present
  on every such table. Write policies are added only where an authenticated
  end-user genuinely writes directly (e.g. a company admin submitting a manual
  payment proof, an agent adding a conversation note, assigning a conversation).
  Everything else — creating a company, connecting WhatsApp, processing a webhook,
  sending a message, approving a payment, changing a subscription state — happens
  through `apps/api`/`apps/workers/*` using the Supabase **service role**, which
  bypasses RLS but is itself gated by explicit, testable authorization code in
  `packages/tenant` and `packages/billing` (never "the service role can do
  anything, so anything goes"). This mirrors the "server-side authorization, not
  just frontend filtering" rule in the Master Prompt.
- Platform staff (`super_admin`, `platform_support`, `platform_billing_admin`) can
  read across every company via `is_platform_staff()` in each policy. This is
  intentionally broad at the RLS layer (platform staff must be able to support any
  company) but is narrowed at the **application** layer: routine platform actions
  are audited via `audit_logs`, and viewing customer-facing conversation content
  additionally requires an active `support_access_sessions` row (time-limited,
  reason-logged) enforced in `packages/tenant`/`apps/api`, not by RLS alone.

## Adding a new tenant-owned table

1. Add `company_id uuid not null references companies (id) on delete cascade`.
2. `alter table <name> enable row level security;`
3. Add a `select` policy using `has_company_permission(company_id, '<permission>')
or is_platform_staff()` (add the permission key to
   `00000000000009_permission_matrix.sql` in a new migration if it doesn't exist
   yet).
4. Add write policies only if authenticated end-users write directly (see above).
5. Add an isolation assertion to `supabase/tests/rls_tenant_isolation.sql`.
6. Add an index on `company_id` (and `(company_id, <hot column>)` for
   frequently-filtered tables).

## Local development database

See `SUPABASE_SETUP.md` for provisioning a real Supabase project, and
`supabase/tests/README.md` for running the migrations + RLS suite against a plain
local Postgres instance without any Supabase account.
