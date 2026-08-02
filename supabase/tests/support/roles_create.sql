-- Creates non-superuser `authenticated`/`anon` roles and a `service_role`
-- role matching Supabase's convention, BEFORE any migration runs. Real
-- Supabase projects always have these three roles present before a single
-- migration is ever applied; migrations (e.g. 00000000000012_human_handover.sql)
-- issue `grant ... to service_role` / `revoke ... from authenticated` by name,
-- so the roles must already exist for those statements to succeed against a
-- plain local Postgres instance. See supabase/tests/README.md.
--
-- `service_role` gets `bypassrls`, mirroring Supabase's real service_role,
-- which bypasses RLS the same way a table owner/superuser does.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- Every function created from this point forward (i.e. every function any
-- migration creates) automatically grants execute to authenticated/anon at
-- creation time -- mirroring real Supabase, where these roles can call any
-- SECURITY DEFINER helper by default unless a migration explicitly revokes
-- it. This lets migration 00000000000012_human_handover.sql's own
-- signature-qualified `revoke ... from authenticated` statements be the
-- final, authoritative word for its service_role-only functions, without a
-- later blanket "grant execute on all functions" (previously in roles.sql,
-- applied after all migrations) silently re-granting them.
alter default privileges in schema public grant execute on functions to authenticated, anon;

-- Same reasoning, for TABLES: every table created from this point forward
-- (every migration's tables, including handover_events) automatically gets
-- these baseline privileges at creation time, so migration 12's own
-- `revoke insert, update, delete on handover_events from public, anon,
-- authenticated` is the final, authoritative word -- a later blanket
-- "grant ... on all tables in schema public" (run post-migration, as the
-- old roles.sql did) would otherwise silently re-grant direct write access
-- to a table whose only allowed write path is a SECURITY DEFINER function.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public grant select, insert, update on tables to anon;
