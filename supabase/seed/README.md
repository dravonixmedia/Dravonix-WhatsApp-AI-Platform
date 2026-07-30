# Seed data

Applies after `supabase/migrations/*.sql`. Contains only test/demo data, clearly
marked (`is_demo = true`, "DEMO PRICING" labels) -- never confirmed commercial
pricing.

Run order:

1. `001_plans.sql` -- Starter/Business/Professional plan templates + entitlements.
2. `002_demo_tenant.sql` -- the Dravonix Media demo company, its settings,
   branding, demo knowledge base, and a trial subscription.
3. `003_super_admin.sql.template` -- **not** run directly. Follow the
   instructions inside it to create your first super-admin user through
   Supabase Auth, then run the resulting statement once.

Local Postgres (no Supabase project): apply `supabase/tests/support/supabase_local_shim.sql`
first so the `auth` schema exists, then insert a row into `auth.users` yourself
before running `003`'s statement -- see `supabase/tests/README.md`.

Real Supabase project: use the Supabase CLI's `supabase db seed` (configured in
`supabase/config.toml` in a future iteration) or apply these files directly via
`psql "$SUPABASE_DATABASE_URL" -f supabase/seed/001_plans.sql` etc.
