-- Business Currency -- RLS/RPC hardening tests for update_company_currency
-- (migration 15). Run after rls_timezone.sql (via supabase/tests/run.sh),
-- against the same throwaway local Postgres database -- never a hosted
-- Supabase project. Every check either passes silently or RAISE EXCEPTIONs.

begin;

create or replace function test_assert(description text, condition boolean) returns void
  language plpgsql
  as $$
  begin
    if not condition then
      raise exception 'ASSERTION FAILED: %', description;
    else
      raise notice 'OK: %', description;
    end if;
  end;
  $$;

create or replace function test_assert_raises(description text, sql_text text, expected_message text) returns void
  language plpgsql
  as $$
  declare
    caught text;
    did_raise boolean := false;
  begin
    begin
      execute sql_text;
    exception
      when others then
        caught := sqlerrm;
        did_raise := true;
    end;

    if not did_raise then
      raise exception 'ASSERTION FAILED: % -- expected exception "%" but none was raised', description, expected_message;
    end if;
    if caught <> expected_message then
      raise exception 'ASSERTION FAILED: % -- expected exception "%" but got "%"', description, expected_message, caught;
    end if;
    raise notice 'OK: %', description;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Fixtures: two companies. Company A has an owner (settings.manage) and a
-- plain agent (no settings.manage). Company B exists only for cross-tenant
-- checks. Company A starts as Asia/Kolkata + INR (the real DB defaults),
-- used below to prove timezone and currency updates never affect each other.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('2a111111-0000-0000-0000-000000000001', 'owner-cur-a@example.test'),
  ('2a111111-0000-0000-0000-000000000002', 'agent-cur-a@example.test'),
  ('2a111111-0000-0000-0000-000000000003', 'owner-cur-b@example.test'),
  ('2a111111-0000-0000-0000-000000000004', 'ex-member-cur-a@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('2aaaaaaa-1000-0000-0000-000000000001', 'Currency Co A', 'currency-co-a', 'active', true),
  ('2bbbbbbb-1000-0000-0000-000000000002', 'Currency Co B', 'currency-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('2a000001-1000-0000-0000-000000000001', '2aaaaaaa-1000-0000-0000-000000000001', '2a111111-0000-0000-0000-000000000001', 'company_owner', true),
  ('2a000001-1000-0000-0000-000000000002', '2aaaaaaa-1000-0000-0000-000000000001', '2a111111-0000-0000-0000-000000000002', 'agent', true),
  ('2a000001-1000-0000-0000-000000000003', '2bbbbbbb-1000-0000-0000-000000000002', '2a111111-0000-0000-0000-000000000003', 'company_owner', true),
  ('2a000001-1000-0000-0000-000000000004', '2aaaaaaa-1000-0000-0000-000000000001', '2a111111-0000-0000-0000-000000000004', 'agent', false);

select test_assert(
  'companies.timezone defaults to Asia/Kolkata and default_currency defaults to INR (real DB defaults)',
  (select timezone from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'Asia/Kolkata'
  and (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'INR'
);

set local role authenticated;

-- ---------------------------------------------------------------------------
-- update_company_currency
-- ---------------------------------------------------------------------------

select test_set_current_user('2a111111-0000-0000-0000-000000000001');

select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'AED');
select test_assert(
  'Company A owner (settings.manage) can set Company A''s currency to a supported ISO 4217 code',
  (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'AED'
);

select test_assert_raises(
  'update_company_currency rejects an unsupported currency code',
  $$ select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'ABC') $$,
  'invalid_currency'
);

select test_assert_raises(
  'update_company_currency rejects a country name instead of an ISO code',
  $$ select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'DUBAI') $$,
  'invalid_currency'
);

select test_assert_raises(
  'update_company_currency rejects a currency symbol',
  $$ select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', '$') $$,
  'invalid_currency'
);

select test_assert_raises(
  'update_company_currency rejects a 3-letter country code that is not a currency code',
  $$ select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'IND') $$,
  'invalid_currency'
);

select test_set_current_user('2a111111-0000-0000-0000-000000000002');

select test_assert_raises(
  'A plain agent (no settings.manage) cannot change Company A''s currency',
  $$ select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'USD') $$,
  'permission_denied'
);

select test_set_current_user('2a111111-0000-0000-0000-000000000003');

select test_assert_raises(
  'Company B owner cannot change Company A''s currency -- browser-supplied company_id is never trusted',
  $$ select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'USD') $$,
  'not_a_member'
);

select test_assert(
  'The rejected cross-tenant attempt above never actually changed Company A''s currency',
  (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'AED'
);

select test_set_current_user('2a111111-0000-0000-0000-000000000004');

select test_assert_raises(
  'A revoked (is_active=false) former member cannot change Company A''s currency',
  $$ select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'USD') $$,
  'not_a_member'
);

-- ---------------------------------------------------------------------------
-- Independence: business timezone and business currency never affect each
-- other, in either direction, across the exact sequence the product spec
-- calls out (Asia/Kolkata+INR -> Asia/Dubai+INR -> Asia/Dubai+AED).
-- ---------------------------------------------------------------------------

select test_set_current_user('2a111111-0000-0000-0000-000000000001');

select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'INR');
select test_assert(
  'Reset: Company A is back to Asia/Kolkata + INR before the independence sequence',
  (select timezone from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'Asia/Kolkata'
  and (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'INR'
);

select update_company_timezone('2aaaaaaa-1000-0000-0000-000000000001', 'Asia/Dubai');
select test_assert(
  'Updating timezone to Asia/Dubai changes only timezone -- currency stays INR, unchanged',
  (select timezone from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'Asia/Dubai'
  and (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'INR'
);

select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'AED');
select test_assert(
  'Updating currency to AED changes only currency -- timezone stays Asia/Dubai, unchanged',
  (select timezone from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'Asia/Dubai'
  and (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'AED'
);

-- ---------------------------------------------------------------------------
-- Hardening sweep: not directly executable by anon/public, empty search_path.
-- ---------------------------------------------------------------------------

reset role;

select test_assert(
  'anon cannot execute update_company_currency',
  not has_function_privilege('anon', 'update_company_currency(uuid, text)', 'execute')
);
select test_assert(
  'public cannot execute update_company_currency',
  not has_function_privilege('public', 'update_company_currency(uuid, text)', 'execute')
);

select test_assert(
  'update_company_currency runs with an empty search_path',
  exists (
    select 1 from pg_proc p, unnest(p.proconfig) cfg
    where p.proname = 'update_company_currency'
      and cfg like 'search_path=%' and cfg not like 'search_path=%public%'
  )
);

rollback;
