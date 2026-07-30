# Database / RLS tests

`rls_tenant_isolation.sql` is an executable, assertion-based test of every tenant
isolation guarantee in `docs/architecture/adr-0001-multi-tenant-strategy.md`: two
companies, cross-tenant reads on contacts/messages/knowledge/leads/invoices, a
`billing_viewer` who cannot read messages, an `agent` who cannot read invoices, a
disabled member who loses access immediately, an anonymous caller who sees nothing,
and platform support staff who can read across tenants.

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
- `support/roles.sql` — creates non-superuser `authenticated`/`anon` roles and
  grants them table/function privileges. This matters because Postgres RLS is
  bypassed for superusers and table owners; the migrations are applied by a
  superuser, so the test file explicitly `SET LOCAL ROLE authenticated` before
  running any assertion, otherwise the test would silently pass even with RLS
  disabled.

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
