-- Creates non-superuser, non-owner `authenticated`/`anon` roles matching
-- Supabase's convention, and grants them table/function privileges so RLS
-- policies are actually enforced when the test suite runs as these roles
-- rather than as the migration-owning superuser. See supabase/tests/README.md.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
end
$$;

grant usage on schema public to authenticated, anon;
grant usage on schema auth to authenticated, anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema auth to authenticated;
grant select, insert, update on all tables in schema public to anon;
grant execute on all functions in schema public to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
