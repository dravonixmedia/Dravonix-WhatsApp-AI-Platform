-- Minimal shim reproducing the one part of Supabase's platform bootstrap
-- that migration 00000000000013_dashboard_realtime.sql depends on: a real
-- Supabase project always has a `supabase_realtime` publication already
-- present before a single migration ever runs (Supabase creates it at
-- project provisioning time). A plain local Postgres instance has no such
-- publication, so this creates an empty one -- mirroring supabase_local_
-- shim.sql's approach for `auth.*` -- purely so migration 13's own
-- existence guard (`raise exception` if the publication is missing) can be
-- exercised the same way it would run against a real project, rather than
-- always hitting its own "unexpected environment" abort path locally.
--
-- This file is a TEST-ONLY harness. It is never applied to a real Supabase
-- project (which already provides this publication) -- see
-- supabase/tests/README.md.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
