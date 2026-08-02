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
