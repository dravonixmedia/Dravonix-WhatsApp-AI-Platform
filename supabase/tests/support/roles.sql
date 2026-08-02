-- Grants broad TABLE privileges to the `authenticated`/`anon`/`service_role`
-- roles created by roles_create.sql, so RLS policies are actually enforced
-- when the test suite runs as these roles rather than as the
-- migration-owning superuser. Must run AFTER all migrations, since
-- `grant ... on all tables in schema public` only affects tables that exist
-- at the time the statement runs. See supabase/tests/README.md.
--
-- Deliberately does NOT grant function execute privileges here (unlike the
-- table grants, those are handled per-function: roles_create.sql's
-- `alter default privileges` grants execute to authenticated/anon at each
-- function's creation time, and 00000000000012_human_handover.sql explicitly
-- revokes/grants its own service_role-only functions. A blanket post-migration
-- "grant execute on all functions" here would silently undo those revokes.

grant usage on schema public to authenticated, anon, service_role;
grant usage on schema auth to authenticated, anon, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema auth to authenticated;
grant select, insert, update on all tables in schema public to anon;

-- service_role: full table access (mirrors Supabase's real service_role,
-- which bypasses RLS via `bypassrls` and is otherwise treated as a trusted
-- backend role with unrestricted table access).
grant select, insert, update, delete on all tables in schema public to service_role;
grant select on all tables in schema auth to service_role;
