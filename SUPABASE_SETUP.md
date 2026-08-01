# SUPABASE_SETUP.md

## 0. One project per environment

Create **two separate Supabase projects** — never share one project between
staging and production, and never point a staging Cloudflare Worker
(`--env staging`, see `CLOUDFLARE_SETUP.md`) at the production project's
credentials. Run every step below once per project.

| Environment | Project ref | Notes                                                                |
| ----------- | ----------- | -------------------------------------------------------------------- |
| Staging     | _fill in_   | Safe to seed with `002_demo_tenant.sql`, reset, or drop and recreate |
| Production  | _fill in_   | Already provisioned and live (see `TASKS.md`) — do not recreate      |

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
