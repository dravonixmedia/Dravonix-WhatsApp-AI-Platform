# SUPABASE_SETUP.md

## 0. One project per environment

Create **two separate Supabase projects** — never share one project between
staging and production, and never point a staging Cloudflare Worker
(`--env staging`, see `CLOUDFLARE_SETUP.md`) at the production project's
credentials. Run every step below once per project.

| Environment | Project ref                                      | Notes                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staging     | `lshfkxirfbjwlklqwqnf` (dravonixmedia's Project) | Confirmed staging as of this writing. Existing rows (messages, webhook_events, media_files, transcriptions, contacts, leads) are dev/test records created through the Meta test number — **not real client data**. See §3a: schema is current through migration 11, but the CLI's own migration-history bookkeeping was never populated here. |
| Production  | _fill in_                                        | Already provisioned and live (see `TASKS.md`) — do not recreate                                                                                                                                                                                                                                                                               |

Fill in each project's ref (Project Settings → General → Reference ID) here
once created, so the mapping from Cloudflare environment to Supabase project
is recorded somewhere other than someone's memory.

## 1. Create a project

1. Create a project at https://supabase.com (or run Supabase locally with the
   Supabase CLI — `supabase start`).
2. Note the project URL, `anon` key, and `service_role` key
   (Project Settings → API). Never expose the `service_role` key to a browser
   bundle or a `NEXT_PUBLIC_*` variable.
3. Note the Postgres connection string (Project Settings → Database) for
   `SUPABASE_DATABASE_URL`.

## 2. Enable required extensions

The migrations enable these themselves (`00000000000001_extensions.sql`), but
if applying manually first ensure your Supabase project supports:

- `pgcrypto` (bundled by default)
- `pg_trgm` (bundled by default)
- `vector` (pgvector — enable via Database → Extensions if not already on)

## 3. Apply migrations

Using the Supabase CLI (recommended):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or apply each file directly in order with `psql`:

```bash
for f in supabase/migrations/*.sql; do
  psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

All nine migration files have been verified against a real local Postgres 16 +
pgvector instance with zero errors (see `DATABASE.md`).

## 3a. Migration history reconciliation — required before migration 12 (staging)

**Status on the staging project (`lshfkxirfbjwlklqwqnf`) as of this writing:**
migrations `00000000000001` through `00000000000011` were applied directly
against Postgres (the `psql` method in §3 above), not through
`supabase db push` — confirmed by inspecting the live database directly:
every table from all 11 migrations exists, installed extensions match
migration 1 exactly, and `search_knowledge_chunks`'s live function body
matches migration 11's rewrite verbatim (not migration 10's superseded
version). The schema is **functionally current through migration 11**.

However, the `supabase_migrations` schema — the table Supabase's own tooling
(`supabase migration list`, `db push`) reads to know what's already
applied — does not exist on this project at all. The CLI has no record of
any of these 11 migrations, even though their effects are all present.

**⚠️ Do not run `supabase db push` or `apply_migration` against staging
until this is reconciled.** With no tracked history, either would treat all
11 migrations as pending and try to re-run them — `create table` in
migrations 2–9 has no `if not exists` guard, so this would fail immediately
with "relation already exists" rather than silently succeeding. This applies
to migration 12 too: a new migration can't be safely pushed until the CLI
agrees the first 11 are already applied.

**Proposed reconciliation (not yet executed — requires explicit approval):**

```bash
supabase link --project-ref lshfkxirfbjwlklqwqnf
supabase migration repair --status applied \
  00000000000001 00000000000002 00000000000003 00000000000004 \
  00000000000005 00000000000006 00000000000007 00000000000008 \
  00000000000009 00000000000010 00000000000011 \
  --linked
```

`migration repair --status applied` only writes rows into
`supabase_migrations.schema_migrations` recording each version as applied —
it does not execute any of the migrations' SQL, so it cannot touch existing
tables, rows, or the current schema. After it runs, `supabase migration
list` should show all 11 as applied both locally and remotely with no diff,
and only then is `supabase db push` (for migration 12+) safe to run against
this project.

## 4. Seed data

```bash
psql "$SUPABASE_DATABASE_URL" -f supabase/seed/001_plans.sql
psql "$SUPABASE_DATABASE_URL" -f supabase/seed/002_demo_tenant.sql
```

Do **not** run `supabase/seed/003_super_admin.sql.template` as-is — it's a
template. See the next section.

## 5. Create your first super-admin

`auth.users` is managed by Supabase Auth (GoTrue); create the user there, not
via a raw SQL insert:

1. Dashboard → Authentication → Users → **Add user** (set a password, or send
   an invite email), or via the CLI:
   ```bash
   supabase auth admin create-user --email you@dravonix.example
   ```
2. Copy the resulting user's UUID.
3. Run, with the UUID substituted:
   ```sql
   insert into platform_members (user_id, role, is_active)
   values ('<uuid>', 'super_admin', true);
   ```

## 6. Environment variables

Set in `.env` (local) and as Cloudflare Worker secrets/vars (deployed):

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=      # server/worker-only, never public
SUPABASE_DATABASE_URL=
NEXT_PUBLIC_SUPABASE_URL=       # apps/web only, safe for the browser
NEXT_PUBLIC_SUPABASE_ANON_KEY=  # apps/web only, safe for the browser
```

Set these as `wrangler secret put <NAME> --env staging` / `--env production`
(see `CLOUDFLARE_SETUP.md` §4) using each environment's **own** project's
values — the staging Worker must never receive the production project's
`SUPABASE_SERVICE_ROLE_KEY` or vice versa. CI (`.github/workflows/ci.yml`)
does not set any of these; it runs migrations and RLS tests against a
throwaway Postgres container instead (see `supabase/tests/README.md`), never
against either real Supabase project.

## 7. Verifying Row Level Security

Run the executable isolation suite against a disposable Postgres instance
(does not touch your Supabase project) — see `supabase/tests/README.md`:

```bash
TEST_DATABASE_ADMIN_URL="postgresql:///postgres?user=postgres" bash supabase/tests/run.sh
```

If you want to sanity-check RLS against the actual Supabase project instead,
create two test users via Auth, add them to two different seeded companies via
`company_members`, and confirm (via the Supabase SQL editor's "impersonate
user" feature or the JS client with each user's session) that neither can read
the other's rows in `contacts`, `messages`, `invoices`, etc.
