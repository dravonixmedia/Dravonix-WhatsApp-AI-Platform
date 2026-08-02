-- Grants schema usage plus `auth`-schema table reads to the `authenticated`/
-- `anon`/`service_role` roles created by roles_create.sql. Must run AFTER
-- all migrations for consistency with the rest of this file's history, but
-- nothing here is actually migration-order-sensitive: `auth.users` is
-- created once by supabase_local_shim.sql and never altered by any
-- migration, so a single blanket select grant is safe.
--
-- Deliberately does NOT grant any privilege on `public`-schema tables here
-- (unlike table reads on `auth`, those are handled per-table at creation
-- time): roles_create.sql's `alter default privileges` grants the baseline
-- select/insert/update[/delete] to authenticated/anon/service_role as each
-- public-schema table is created, and 00000000000012_human_handover.sql
-- explicitly revokes direct writes on handover_events. A blanket
-- post-migration "grant ... on all tables in schema public" here would
-- silently undo that revoke, exactly as a blanket function-execute grant
-- would have undone migration 12's function-level revokes.

grant usage on schema public to authenticated, anon, service_role;
grant usage on schema auth to authenticated, anon, service_role;
grant select on all tables in schema auth to authenticated, service_role;
