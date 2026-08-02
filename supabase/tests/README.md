# Database / RLS tests

`rls_tenant_isolation.sql` is an executable, assertion-based test of every tenant
isolation guarantee in `docs/architecture/adr-0001-multi-tenant-strategy.md`: two
companies, cross-tenant reads on contacts/messages/knowledge/leads/invoices, a
`billing_viewer` who cannot read messages, an `agent` who cannot read invoices, a
disabled member who loses access immediately, an anonymous caller who sees nothing,
and platform support staff who can read across tenants.

`rls_handover.sql` is the equivalent suite for the Human Handover Inbox
(migration `00000000000012_human_handover.sql`, final plan section 18):
`handover_events`' RLS/no-direct-write hardening, the human-reply assignment/
override authorization chain, outbound-message lease/claim concurrency,
`reconcile_outbound_message`'s status/authorization rules,
`trigger_handover`'s idempotency (including surviving a full state cycle back
to `ai_active` -- the bug an earlier revision of this migration had),
`expire_stale_outbound_sends`, and a hardening sweep asserting all 13 new
functions have an empty `search_path` and the exact execute-privilege grants
their trust family requires.

It runs against a real Postgres instance (any Postgres 16 with the `vector`
extension available — the `pgvector/pgvector:pg16` Docker image, or
`postgresql-16-pgvector` on Debian/Ubuntu), not just against Supabase. Two support
files make that possible without the full Supabase stack:

- `support/supabase_local_shim.sql` — creates an `auth` schema with a minimal
  `auth.users` table and `auth.uid()`/`auth.role()` functions matching Supabase's
  real implementation, plus `test_set_current_user()`/`test_clear_current_user()`
  helpers the test file uses to simulate different logged-in users within one
  session. **Never applied to a real Supabase project** — Supabase already
  provides the real versions of these.
- `support/roles_create.sql` — creates non-superuser `authenticated`/`anon`/
  `service_role` roles (run _before_ any migration), and sets
  `alter default privileges ... grant execute on functions to authenticated,
anon` so every function a migration creates is executable by them by
  default, exactly like on a real Supabase project. This must run before the
  migrations because `00000000000012_human_handover.sql` grants/revokes
  execute on these roles by name for its own functions, and those role-name
  references would fail to resolve if the roles didn't already exist.
  `roles_create.sql` sets the equivalent `alter default privileges ... on
tables` for the same reason: migration 12's `revoke insert, update,
delete on handover_events from public, anon, authenticated` must be the
  final word for that table too.
- `support/roles.sql` — grants schema `usage` plus `auth`-schema table reads
  (run _after_ all migrations, for consistency, though nothing in it is
  actually migration-order-sensitive). This matters because Postgres RLS is
  bypassed for superusers and table owners; the migrations are applied by a
  superuser, so the test file explicitly `SET LOCAL ROLE authenticated`
  before running any assertion, otherwise the test would silently pass even
  with RLS disabled. It deliberately does not grant any blanket
  `public`-schema table or function privilege (that's `roles_create.sql`'s
  per-object-creation-time job) -- a blanket post-migration grant here would
  silently undo migration 12's own revokes for its service_role-only
  functions and for direct writes to `handover_events`.

## Running locally

```bash
# One-time (Debian/Ubuntu, if not already installed):
sudo apt-get install -y postgresql-16 postgresql-16-pgvector

# Run the full suite (creates a scratch DB, applies every migration, runs the
# assertions, drops the scratch DB):
TEST_DATABASE_ADMIN_URL="postgresql:///postgres?user=postgres" \
  bash supabase/tests/run.sh
```

`TEST_DATABASE_ADMIN_URL` defaults to `postgresql://postgres@localhost:5432/postgres`;
override it to point at a different admin connection (e.g. a Dockerized
`pgvector/pgvector:pg16` container exposed on a non-default port).

Every assertion in `rls_tenant_isolation.sql` is a `test_assert(description,
condition)` call that `RAISE EXCEPTION`s on failure, so `run.sh` exits non-zero the
moment any isolation guarantee breaks — this is wired into CI (`.github/workflows/ci.yml`).

## What this does _not_ cover yet

This suite validates RLS at the SQL layer only. It does not exercise:

- Storage-path tenant scoping (covered by unit tests on the key builder in
  `packages/storage`, not a live Supabase Storage bucket).
- The full Supabase Auth JWT flow (session refresh, MFA, etc.) — the shim only
  reproduces `auth.uid()`/`auth.role()`, the two functions our policies call.
- pgTAP-style structured test reporting. If the project later needs richer
  reporting (JUnit XML, etc.), migrating this file to `pgTAP` is a natural next
  step; the assertions themselves would not need to change conceptually.
