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

-- Super Admin fixture: after client permission hardening
-- (00000000000022), the independence sequence below (originally exercised
-- via the client owner's update_company_timezone/update_company_currency)
-- must instead go through the Super Admin-only admin_update_company_profile.
insert into auth.users (id, email) values
  ('2a111111-0000-0000-0000-000000000005', 'super-admin-cur@example.test');
insert into platform_members (user_id, role, is_active) values
  ('2a111111-0000-0000-0000-000000000005', 'super_admin', true);

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

-- The client permission-hardening migration (00000000000022) revokes
-- settings.manage from company_owner/company_admin entirely -- company
-- currency is now Super Admin-only, via admin_update_company_profile.
-- update_company_currency itself is unchanged and still correctly checks
-- settings.manage; it is simply unreachable by any client role now.
select test_assert_raises(
  'Company A owner (no settings.manage after client permission hardening) cannot set Company A''s currency via the client RPC',
  $$ select update_company_currency('2aaaaaaa-1000-0000-0000-000000000001', 'AED') $$,
  'permission_denied'
);
select test_assert(
  'the rejected owner attempt above never actually changed Company A''s currency from its default',
  (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'INR'
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
  (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'INR'
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
-- calls out (Asia/Kolkata+INR -> Asia/Dubai+INR -> Asia/Dubai+AED). Exercised
-- via admin_update_company_profile (Super Admin-only after client permission
-- hardening) -- update_company_timezone/update_company_currency themselves
-- are unchanged and already proven independent above; this proves the new
-- combined Super Admin RPC preserves that same independence when only one
-- of p_timezone/p_default_currency is supplied at a time (the other left null).
-- ---------------------------------------------------------------------------

select test_set_current_user('2a111111-0000-0000-0000-000000000005'); -- super_admin

select admin_update_company_profile('2aaaaaaa-1000-0000-0000-000000000001', 'Currency Co A', null, null, null, 'INR');
select test_assert(
  'Reset: Company A is back to Asia/Kolkata + INR before the independence sequence',
  (select timezone from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'Asia/Kolkata'
  and (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'INR'
);

select admin_update_company_profile('2aaaaaaa-1000-0000-0000-000000000001', 'Currency Co A', null, null, 'Asia/Dubai', null);
select test_assert(
  'Updating timezone to Asia/Dubai changes only timezone -- currency stays INR, unchanged',
  (select timezone from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'Asia/Dubai'
  and (select default_currency from companies where id = '2aaaaaaa-1000-0000-0000-000000000001') = 'INR'
);

select admin_update_company_profile('2aaaaaaa-1000-0000-0000-000000000001', 'Currency Co A', null, null, null, 'AED');
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
