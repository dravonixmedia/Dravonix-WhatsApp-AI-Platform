-- Minimal shim reproducing the parts of Supabase's `auth` schema that our
-- migrations and RLS policies depend on (auth.users, auth.uid(), auth.role()),
-- so migrations can be exercised against a plain local Postgres instance without
-- the full Supabase stack (GoTrue, realtime, etc).
--
-- This file is a TEST-ONLY harness. It is never applied to a real Supabase
-- project (which already provides these) -- see supabase/tests/README.md.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid
  language sql stable
  as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;

create or replace function auth.role() returns text
  language sql stable
  as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
  $$;

-- Helper used only by tests to switch the simulated authenticated user.
create or replace function test_set_current_user(p_user_id uuid) returns void
  language sql
  as $$
    select set_config('request.jwt.claim.sub', p_user_id::text, false);
    select set_config('request.jwt.claim.role', 'authenticated', false);
  $$;

create or replace function test_clear_current_user() returns void
  language sql
  as $$
    select set_config('request.jwt.claim.sub', '', false);
    select set_config('request.jwt.claim.role', 'anon', false);
  $$;
