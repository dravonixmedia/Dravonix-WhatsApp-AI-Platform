-- Global Timezone + Daypart Awareness -- RLS/RPC hardening tests for
-- update_company_timezone and update_contact_timezone (migration 14). Run
-- after rls_handover.sql (via supabase/tests/run.sh), against the same
-- throwaway local Postgres database -- never a hosted Supabase project.
-- Every check either passes silently or RAISE EXCEPTIONs.

begin;

-- ---------------------------------------------------------------------------
-- Assertion helpers (each test file defines/rolls back its own copy -- see
-- rls_handover.sql, the identical pattern).
-- ---------------------------------------------------------------------------

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
-- Fixtures: two companies. Company A has an owner (settings.manage,
-- conversations.reply via role grants) and a plain agent (conversations.reply
-- only, no settings.manage). Company B exists only for cross-tenant checks.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('1a111111-0000-0000-0000-000000000001', 'owner-tz-a@example.test'),
  ('1a111111-0000-0000-0000-000000000002', 'agent-tz-a@example.test'),
  ('1a111111-0000-0000-0000-000000000003', 'owner-tz-b@example.test'),
  ('1a111111-0000-0000-0000-000000000004', 'ex-member-tz-a@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('1aaaaaaa-1000-0000-0000-000000000001', 'Timezone Co A', 'timezone-co-a', 'active', true),
  ('1bbbbbbb-1000-0000-0000-000000000002', 'Timezone Co B', 'timezone-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('1a000001-1000-0000-0000-000000000001', '1aaaaaaa-1000-0000-0000-000000000001', '1a111111-0000-0000-0000-000000000001', 'company_owner', true),
  ('1a000001-1000-0000-0000-000000000002', '1aaaaaaa-1000-0000-0000-000000000001', '1a111111-0000-0000-0000-000000000002', 'agent', true),
  ('1a000001-1000-0000-0000-000000000003', '1bbbbbbb-1000-0000-0000-000000000002', '1a111111-0000-0000-0000-000000000003', 'company_owner', true),
  ('1a000001-1000-0000-0000-000000000004', '1aaaaaaa-1000-0000-0000-000000000001', '1a111111-0000-0000-0000-000000000004', 'agent', false);

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('1c000000-1000-0000-0000-00000000000a', '1aaaaaaa-1000-0000-0000-000000000001', '911000009001', 'Customer TZ A'),
  ('1c000000-1000-0000-0000-00000000000b', '1bbbbbbb-1000-0000-0000-000000000002', '911000009002', 'Customer TZ B');

select test_assert(
  'contacts.timezone defaults to null (unknown) -- never a hidden default',
  (select timezone from contacts where id = '1c000000-1000-0000-0000-00000000000a') is null
);

set local role authenticated;

-- ---------------------------------------------------------------------------
-- update_company_timezone
-- ---------------------------------------------------------------------------

select test_set_current_user('1a111111-0000-0000-0000-000000000001');

-- The client permission-hardening migration (00000000000022) revokes
-- settings.manage from company_owner/company_admin entirely -- company
-- timezone is now Super Admin-only, via admin_update_company_profile.
-- update_company_timezone itself is unchanged and still correctly checks
-- settings.manage; it is simply unreachable by any client role now.
select test_assert_raises(
  'Company A owner (no settings.manage after client permission hardening) cannot set Company A''s timezone via the client RPC',
  $$ select update_company_timezone('1aaaaaaa-1000-0000-0000-000000000001', 'Asia/Dubai') $$,
  'permission_denied'
);

select test_assert(
  'the rejected owner attempt above never actually changed Company A''s timezone from its default',
  (select timezone from companies where id = '1aaaaaaa-1000-0000-0000-000000000001') = 'Asia/Kolkata'
);

select test_assert_raises(
  'update_company_timezone rejects a bare numeric UTC offset even though it is not company A''s own value',
  $$ select update_company_timezone('1aaaaaaa-1000-0000-0000-000000000001', '+05:30') $$,
  'invalid_timezone'
);

select test_assert_raises(
  'update_company_timezone rejects a nonsense timezone string',
  $$ select update_company_timezone('1aaaaaaa-1000-0000-0000-000000000001', 'Not/A/Zone') $$,
  'invalid_timezone'
);

select test_set_current_user('1a111111-0000-0000-0000-000000000002');

select test_assert_raises(
  'A plain agent (no settings.manage) cannot change Company A''s timezone',
  $$ select update_company_timezone('1aaaaaaa-1000-0000-0000-000000000001', 'Europe/London') $$,
  'permission_denied'
);

select test_set_current_user('1a111111-0000-0000-0000-000000000003');

select test_assert_raises(
  'Company B owner cannot change Company A''s timezone -- browser-supplied company_id is never trusted',
  $$ select update_company_timezone('1aaaaaaa-1000-0000-0000-000000000001', 'America/New_York') $$,
  'not_a_member'
);

select test_assert(
  'The rejected cross-tenant attempt above never actually changed Company A''s timezone',
  (select timezone from companies where id = '1aaaaaaa-1000-0000-0000-000000000001') = 'Asia/Kolkata'
);

select test_set_current_user('1a111111-0000-0000-0000-000000000004');

select test_assert_raises(
  'A revoked (is_active=false) former member cannot change Company A''s timezone',
  $$ select update_company_timezone('1aaaaaaa-1000-0000-0000-000000000001', 'Europe/London') $$,
  'not_a_member'
);

-- ---------------------------------------------------------------------------
-- update_contact_timezone
-- ---------------------------------------------------------------------------

select test_set_current_user('1a111111-0000-0000-0000-000000000002');

select update_contact_timezone('1c000000-1000-0000-0000-00000000000a', 'Europe/London');
select test_assert(
  'An agent with conversations.reply can set a Company A contact''s timezone',
  (select timezone from contacts where id = '1c000000-1000-0000-0000-00000000000a') = 'Europe/London'
);

select update_contact_timezone('1c000000-1000-0000-0000-00000000000a', null);
select test_assert(
  'Passing null explicitly restores the contact''s timezone to unknown, not rejected',
  (select timezone from contacts where id = '1c000000-1000-0000-0000-00000000000a') is null
);

select test_assert_raises(
  'update_contact_timezone rejects a bare numeric UTC offset',
  $$ select update_contact_timezone('1c000000-1000-0000-0000-00000000000a', '-04:00') $$,
  'invalid_timezone'
);

select test_set_current_user('1a111111-0000-0000-0000-000000000003');

select test_assert_raises(
  'Company B owner cannot read/target Company A''s contact by id -- cross-tenant contact id is rejected',
  $$ select update_contact_timezone('1c000000-1000-0000-0000-00000000000a', 'Asia/Dubai') $$,
  'not_a_member'
);

select test_assert(
  'The rejected cross-tenant contact-timezone attempt above never actually wrote anything',
  (select timezone from contacts where id = '1c000000-1000-0000-0000-00000000000a') is null
);

select test_set_current_user('1a111111-0000-0000-0000-000000000004');

select test_assert_raises(
  'A revoked (is_active=false) former member cannot change a Company A contact''s timezone',
  $$ select update_contact_timezone('1c000000-1000-0000-0000-00000000000a', 'Asia/Dubai') $$,
  'not_a_member'
);

-- ---------------------------------------------------------------------------
-- Hardening sweep: neither RPC is directly executable by anon/public, and
-- both run with an empty search_path (matches every migration-12 RPC).
-- ---------------------------------------------------------------------------

reset role;

select test_assert(
  'anon cannot execute update_company_timezone',
  not has_function_privilege('anon', 'update_company_timezone(uuid, text)', 'execute')
);
select test_assert(
  'public cannot execute update_company_timezone',
  not has_function_privilege('public', 'update_company_timezone(uuid, text)', 'execute')
);
select test_assert(
  'anon cannot execute update_contact_timezone',
  not has_function_privilege('anon', 'update_contact_timezone(uuid, text)', 'execute')
);
select test_assert(
  'public cannot execute update_contact_timezone',
  not has_function_privilege('public', 'update_contact_timezone(uuid, text)', 'execute')
);

select test_assert(
  'update_company_timezone runs with an empty search_path',
  exists (
    select 1 from pg_proc p, unnest(p.proconfig) cfg
    where p.proname = 'update_company_timezone'
      and cfg like 'search_path=%' and cfg not like 'search_path=%public%'
  )
);
select test_assert(
  'update_contact_timezone runs with an empty search_path',
  exists (
    select 1 from pg_proc p, unnest(p.proconfig) cfg
    where p.proname = 'update_contact_timezone'
      and cfg like 'search_path=%' and cfg not like 'search_path=%public%'
  )
);

rollback;
