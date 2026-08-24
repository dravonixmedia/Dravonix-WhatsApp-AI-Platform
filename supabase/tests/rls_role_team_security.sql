-- Phase 2 role model expansion (migrations 23/24) RLS/RPC hardening tests.
-- Run after rls_client_onboarding.sql (via supabase/tests/run.sh), against
-- the same throwaway local Postgres database -- never a hosted Supabase
-- project.

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

create or replace function test_assert_raises_like(description text, sql_text text, expected_pattern text) returns void
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
      raise exception 'ASSERTION FAILED: % -- expected an exception matching "%" but none was raised', description, expected_pattern;
    end if;
    if caught !~ expected_pattern then
      raise exception 'ASSERTION FAILED: % -- expected exception matching "%" but got "%"', description, expected_pattern, caught;
    end if;
    raise notice 'OK: %', description;
  end;
  $$;

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- Company A: a normal, fully-staffed company -- one active owner plus one of
-- each new/carried-over role, for the team-management and handover
-- authorization assertions.
-- Company B: a second company, owner only, for cross-tenant assertions.
-- Company C: an active member but ZERO active owners (the known Dravonix
-- Media staging shape) -- proves the database-level constraint tolerates
-- this, and that Super Admin can repair it by promoting the existing admin.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('a0000002-0000-0000-0000-000000000001', 'super-admin-2@example.test'),
  ('a2000001-0000-0000-0000-000000000001', 'owner-a2@example.test'),
  ('a2000001-0000-0000-0000-000000000002', 'admin-a2@example.test'),
  ('a2000001-0000-0000-0000-000000000003', 'manager-a2@example.test'),
  ('a2000001-0000-0000-0000-000000000004', 'teamlead-a2@example.test'),
  ('a2000001-0000-0000-0000-000000000005', 'sales-a2@example.test'),
  ('a2000001-0000-0000-0000-000000000006', 'accounts-a2@example.test'),
  ('a2000002-0000-0000-0000-000000000001', 'owner-b2@example.test'),
  ('a2000003-0000-0000-0000-000000000001', 'admin-c2@example.test'),
  ('a2000004-0000-0000-0000-000000000001', 'invitee-a2@example.test');

insert into platform_members (user_id, role, is_active) values
  ('a0000002-0000-0000-0000-000000000001', 'super_admin', true);

insert into companies (id, name, slug, status, is_demo) values
  ('b2000001-0000-0000-0000-000000000001', 'Role Sec Co A', 'role-sec-co-a', 'active', true),
  ('b2000002-0000-0000-0000-000000000001', 'Role Sec Co B', 'role-sec-co-b', 'active', true),
  ('b2000003-0000-0000-0000-000000000001', 'Role Sec Co C (zero owner)', 'role-sec-co-c', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('c2000001-0000-0000-0000-000000000001', 'b2000001-0000-0000-0000-000000000001', 'a2000001-0000-0000-0000-000000000001', 'company_owner', true),
  ('c2000001-0000-0000-0000-000000000002', 'b2000001-0000-0000-0000-000000000001', 'a2000001-0000-0000-0000-000000000002', 'company_admin', true),
  ('c2000001-0000-0000-0000-000000000003', 'b2000001-0000-0000-0000-000000000001', 'a2000001-0000-0000-0000-000000000003', 'manager', true),
  ('c2000001-0000-0000-0000-000000000004', 'b2000001-0000-0000-0000-000000000001', 'a2000001-0000-0000-0000-000000000004', 'team_leader', true),
  ('c2000001-0000-0000-0000-000000000005', 'b2000001-0000-0000-0000-000000000001', 'a2000001-0000-0000-0000-000000000005', 'sales_person', true),
  ('c2000001-0000-0000-0000-000000000006', 'b2000001-0000-0000-0000-000000000001', 'a2000001-0000-0000-0000-000000000006', 'company_accounts', true),
  ('c2000002-0000-0000-0000-000000000001', 'b2000002-0000-0000-0000-000000000001', 'a2000002-0000-0000-0000-000000000001', 'company_owner', true),
  ('c2000003-0000-0000-0000-000000000001', 'b2000003-0000-0000-0000-000000000001', 'a2000003-0000-0000-0000-000000000001', 'company_admin', true);

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('e2000001-0000-0000-0000-000000000001', 'b2000001-0000-0000-0000-000000000001', '911234567890', 'Handover Test Contact');

insert into conversations (id, company_id, contact_id, state, assigned_member_id) values
  ('d2000001-0000-0000-0000-000000000001', 'b2000001-0000-0000-0000-000000000001', 'e2000001-0000-0000-0000-000000000001', 'human_active', 'c2000001-0000-0000-0000-000000000005'),
  ('d2000001-0000-0000-0000-000000000002', 'b2000001-0000-0000-0000-000000000001', 'e2000001-0000-0000-0000-000000000001', 'human_active', 'c2000001-0000-0000-0000-000000000005'),
  ('d2000001-0000-0000-0000-000000000003', 'b2000001-0000-0000-0000-000000000001', 'e2000001-0000-0000-0000-000000000001', 'human_active', 'c2000001-0000-0000-0000-000000000005'),
  ('d2000001-0000-0000-0000-000000000004', 'b2000001-0000-0000-0000-000000000001', 'e2000001-0000-0000-0000-000000000001', 'human_active', 'c2000001-0000-0000-0000-000000000005'),
  ('d2000001-0000-0000-0000-000000000005', 'b2000001-0000-0000-0000-000000000001', 'e2000001-0000-0000-0000-000000000001', 'human_active', 'c2000001-0000-0000-0000-000000000005'),
  ('d2000001-0000-0000-0000-000000000006', 'b2000001-0000-0000-0000-000000000001', 'e2000001-0000-0000-0000-000000000001', 'human_active', 'c2000001-0000-0000-0000-000000000006');

-- ---------------------------------------------------------------------------
-- Hardening sweep for the one genuinely new function this migration adds
-- (company_reactivate_member) -- every redefined function (create_company_
-- invitation, company_change_member_role, company_deactivate_member,
-- admin_change_company_member_role, admin_deactivate_company_member,
-- admin_invite_company_member, handover_end_human_assistance,
-- handover_close_conversation) keeps the exact same hardening template it
-- already had (security definer, empty search_path, signature-qualified
-- REVOKE/GRANT) -- migration 24 only changes their authorization logic.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_proc p
    where p.proname = 'company_reactivate_member'
      and exists (
        select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%' and cfg not like 'search_path=%public%'
      )
  ) then
    raise exception 'ASSERTION FAILED: company_reactivate_member does not have an empty search_path set';
  end if;
  if has_function_privilege('anon', (select oid from pg_proc where proname = 'company_reactivate_member' limit 1), 'execute') then
    raise exception 'ASSERTION FAILED: company_reactivate_member is executable by anon';
  end if;
  raise notice 'OK: company_reactivate_member has an empty search_path and is not executable by anon';
end;
$$;

set local role authenticated;

-- Platform staff bypasses tenant-scoped RLS on company_members (is_platform_
-- staff() OR branch) -- needed for the two fixture-sanity counts below,
-- which run before any test targets a specific caller.
select test_set_current_user('a0000002-0000-0000-0000-000000000001'); -- super_admin

-- ---------------------------------------------------------------------------
-- 1. Owner constraint (company_members_one_active_owner_uq).
-- ---------------------------------------------------------------------------

select test_assert(
  'one active owner per company is valid (Company A)',
  (select count(*) from company_members where company_id = 'b2000001-0000-0000-0000-000000000001' and role = 'company_owner' and is_active = true) = 1
);

select test_assert(
  'a company with active members but ZERO active owners remains a valid row (Company C, the known staging shape)',
  (select count(*) from company_members where company_id = 'b2000003-0000-0000-0000-000000000001' and role = 'company_owner' and is_active = true) = 0
  and (select count(*) from company_members where company_id = 'b2000003-0000-0000-0000-000000000001' and is_active = true) = 1
);

-- The partial unique index is a database-level backstop against ANY writer,
-- not just RLS-governed client sessions (company_members has no INSERT RLS
-- policy for `authenticated` at all -- every real write goes through a
-- SECURITY DEFINER RPC, which runs as the function owner and so bypasses
-- RLS the same way this direct superuser insert does). Bypassing RLS here
-- is the correct way to exercise the constraint itself, isolated from any
-- RPC-level check.
reset role;
select test_assert_raises_like(
  'a second active company_owner in the same company is rejected at the database level',
  $sql$ insert into company_members (company_id, user_id, role, is_active) values ('b2000001-0000-0000-0000-000000000001', 'a2000004-0000-0000-0000-000000000001', 'company_owner', true) $sql$,
  'company_members_one_active_owner_uq'
);
set local role authenticated;
select test_set_current_user('a2000001-0000-0000-0000-000000000001'); -- owner-a2

-- ---------------------------------------------------------------------------
-- 2. Client invitation hierarchy (create_company_invitation).
-- ---------------------------------------------------------------------------

do $$
declare
  v_id uuid;
begin
  select id into v_id from create_company_invitation('b2000001-0000-0000-0000-000000000001', 'new-manager@example.test', 'manager');
  perform test_assert('owner (team.manage) can invite a normal role', v_id is not null);
end;
$$;

select test_set_current_user('a2000001-0000-0000-0000-000000000002'); -- admin-a2

do $$
declare
  v_id uuid;
begin
  select id into v_id from create_company_invitation('b2000001-0000-0000-0000-000000000001', 'new-sales@example.test', 'sales_person');
  perform test_assert('admin (team.manage) can invite a normal role', v_id is not null);
end;
$$;

select test_assert_raises(
  'the client (team.manage) path cannot invite a company_owner',
  $sql$ select create_company_invitation('b2000001-0000-0000-0000-000000000001', 'wanna-be-owner@example.test', 'company_owner') $sql$,
  'cannot_invite_owner'
);

select test_set_current_user('a0000002-0000-0000-0000-000000000001'); -- super_admin

select test_assert_raises(
  'even super_admin cannot invite a second company_owner into a company that already has an active one',
  $sql$ select create_company_invitation('b2000001-0000-0000-0000-000000000001', 'second-owner@example.test', 'company_owner') $sql$,
  'owner_already_exists'
);

do $$
declare
  v_id uuid;
begin
  select id into v_id from create_company_invitation('b2000003-0000-0000-0000-000000000001', 'new-owner-c@example.test', 'company_owner');
  perform test_assert('super_admin can invite a company_owner into a zero-owner company (Company C)', v_id is not null);
  perform admin_revoke_company_invitation(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Client role-change hierarchy (company_change_member_role).
-- ---------------------------------------------------------------------------

select test_set_current_user('a2000001-0000-0000-0000-000000000001'); -- owner-a2

do $$
declare
  v_role company_role;
begin
  select role into v_role from company_change_member_role('c2000001-0000-0000-0000-000000000003', 'team_leader');
  perform test_assert('owner can change a normal member''s role below owner', v_role = 'team_leader');
  perform company_change_member_role('c2000001-0000-0000-0000-000000000003', 'manager'); -- restore for later assertions
end;
$$;

select test_assert_raises(
  'a client cannot promote a normal member to company_owner',
  $sql$ select company_change_member_role('c2000001-0000-0000-0000-000000000003', 'company_owner') $sql$,
  'invalid_target_role'
);

select test_assert_raises(
  'a client cannot change the current company_owner''s role at all',
  $sql$ select company_change_member_role('c2000001-0000-0000-0000-000000000001', 'manager') $sql$,
  'cannot_change_owner'
);

select test_assert_raises(
  'a client cannot deactivate the current company_owner',
  $sql$ select company_deactivate_member('c2000001-0000-0000-0000-000000000001') $sql$,
  'cannot_deactivate_owner'
);

select test_assert_raises(
  'a client cannot assign a legacy role through company_change_member_role',
  $sql$ select company_change_member_role('c2000001-0000-0000-0000-000000000003', 'viewer') $sql$,
  'invalid_target_role'
);

-- Manager/team_leader/sales_person/company_accounts hold no team.manage --
-- every client team-management RPC must reject them the same way.
select test_set_current_user('a2000001-0000-0000-0000-000000000003'); -- manager-a2
select test_assert_raises(
  'manager cannot team-manage (no team.manage)',
  $sql$ select company_change_member_role('c2000001-0000-0000-0000-000000000005', 'manager') $sql$,
  'permission_denied'
);

select test_set_current_user('a2000001-0000-0000-0000-000000000004'); -- teamlead-a2
select test_assert_raises(
  'team_leader cannot team-manage (no team.manage)',
  $sql$ select company_deactivate_member('c2000001-0000-0000-0000-000000000005') $sql$,
  'permission_denied'
);

select test_set_current_user('a2000001-0000-0000-0000-000000000005'); -- sales-a2
select test_assert_raises(
  'sales_person cannot team-manage (no team.manage)',
  $sql$ select company_change_member_role('c2000001-0000-0000-0000-000000000003', 'team_leader') $sql$,
  'permission_denied'
);

select test_set_current_user('a2000001-0000-0000-0000-000000000006'); -- accounts-a2
select test_assert_raises(
  'company_accounts cannot team-manage (no team.manage)',
  $sql$ select company_deactivate_member('c2000001-0000-0000-0000-000000000005') $sql$,
  'permission_denied'
);

-- Deactivate/reactivate round trip for a normal (non-owner) member.
select test_set_current_user('a2000001-0000-0000-0000-000000000001'); -- owner-a2

do $$
declare
  v_active boolean;
begin
  select is_active into v_active from company_deactivate_member('c2000001-0000-0000-0000-000000000005');
  perform test_assert('owner can deactivate a normal member', v_active = false);
  select is_active into v_active from company_reactivate_member('c2000001-0000-0000-0000-000000000005');
  perform test_assert('owner can reactivate a normal member', v_active = true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cross-tenant rejection for the client team RPCs (tenant isolation).
-- ---------------------------------------------------------------------------

select test_set_current_user('a2000002-0000-0000-0000-000000000001'); -- owner-b2, Company B

select test_assert_raises(
  'Company B''s owner cannot change a Company A member''s role',
  $sql$ select company_change_member_role('c2000001-0000-0000-0000-000000000003', 'sales_person') $sql$,
  'permission_denied'
);

select test_assert_raises(
  'Company B''s owner cannot deactivate a Company A member',
  $sql$ select company_deactivate_member('c2000001-0000-0000-0000-000000000003') $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 5. Super Admin owner protection (admin_change_company_member_role /
--    admin_deactivate_company_member / admin_invite_company_member) --
--    ordinary Super Admin actions must not create a zero-owner or
--    multi-owner state, but repairing an already-zero-owner company (like
--    Company C) remains allowed.
-- ---------------------------------------------------------------------------

select test_set_current_user('a0000002-0000-0000-0000-000000000001'); -- super_admin

select test_assert_raises(
  'ordinary Super Admin role-change cannot demote the current active company_owner',
  $sql$ select admin_change_company_member_role('b2000001-0000-0000-0000-000000000001', 'c2000001-0000-0000-0000-000000000001', 'manager') $sql$,
  'cannot_demote_owner'
);

select test_assert_raises(
  'ordinary Super Admin role-change cannot promote a second member to company_owner while one is active',
  $sql$ select admin_change_company_member_role('b2000001-0000-0000-0000-000000000001', 'c2000001-0000-0000-0000-000000000003', 'company_owner') $sql$,
  'owner_already_exists'
);

select test_assert_raises(
  'ordinary Super Admin deactivation cannot deactivate the current active company_owner',
  $sql$ select admin_deactivate_company_member('b2000001-0000-0000-0000-000000000001', 'c2000001-0000-0000-0000-000000000001') $sql$,
  'cannot_deactivate_owner'
);

select test_assert_raises(
  'admin_invite_company_member cannot create a second active owner via direct invite',
  $sql$ select admin_invite_company_member('b2000001-0000-0000-0000-000000000001', 'owner-a2@example.test', 'company_owner') $sql$,
  'owner_already_exists'
);

do $$
declare
  v_active boolean;
  v_role company_role;
begin
  -- Ordinary non-owner Super Admin management still works, unaffected.
  select is_active into v_active from admin_deactivate_company_member('b2000001-0000-0000-0000-000000000001', 'c2000001-0000-0000-0000-000000000004');
  perform test_assert('Super Admin can still deactivate a normal (non-owner) member', v_active = false);

  -- Repairing Company C's zero-owner state is the sanctioned remediation
  -- path: promoting its existing admin, since no active owner exists yet.
  select role into v_role from admin_change_company_member_role('b2000003-0000-0000-0000-000000000001', 'c2000003-0000-0000-0000-000000000001', 'company_owner');
  perform test_assert('Super Admin CAN promote a member to company_owner in a company with zero active owners (the Company C remediation path)', v_role = 'company_owner');
  perform test_assert(
    'Company C now has exactly one active owner after the remediation',
    (select count(*) from company_members where company_id = 'b2000003-0000-0000-0000-000000000001' and role = 'company_owner' and is_active = true) = 1
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Human Handover close/end authorization (conversations.close, not
--    conversations.assign). Owner/admin/manager/team_leader can End Human
--    Assistance and Close a Conversation; sales_person/company_accounts
--    cannot, even though sales_person is the assigned member on every
--    conversation fixture above (no assigned-member bypass exists).
-- ---------------------------------------------------------------------------

select test_set_current_user('a2000001-0000-0000-0000-000000000001'); -- owner-a2
do $$
declare v_state conversation_state; begin
  select state into v_state from handover_end_human_assistance('d2000001-0000-0000-0000-000000000001');
  perform test_assert('owner (conversations.close) can End Human Assistance', v_state = 'ai_active');
  select state into v_state from handover_close_conversation('d2000001-0000-0000-0000-000000000002');
  perform test_assert('owner (conversations.close) can Close a Conversation', v_state = 'closed');
end; $$;

select test_set_current_user('a2000001-0000-0000-0000-000000000002'); -- admin-a2
do $$
declare v_state conversation_state; begin
  select state into v_state from handover_close_conversation('d2000001-0000-0000-0000-000000000003');
  perform test_assert('admin (conversations.close) can Close a Conversation', v_state = 'closed');
end; $$;

select test_set_current_user('a2000001-0000-0000-0000-000000000003'); -- manager-a2
do $$
declare v_state conversation_state; begin
  select state into v_state from handover_close_conversation('d2000001-0000-0000-0000-000000000004');
  perform test_assert('manager (conversations.close) can Close a Conversation', v_state = 'closed');
end; $$;

-- team_leader was deactivated in section 5 above (Super Admin regression
-- check) -- reactivate it here so this section proves the *permission*
-- grant, not an unrelated deactivation from earlier.
reset role;
update company_members set is_active = true, disabled_at = null where id = 'c2000001-0000-0000-0000-000000000004';
set local role authenticated;

select test_set_current_user('a2000001-0000-0000-0000-000000000004'); -- teamlead-a2
do $$
declare v_state conversation_state; begin
  select state into v_state from handover_close_conversation('d2000001-0000-0000-0000-000000000005');
  perform test_assert('team_leader (conversations.close) can Close a Conversation', v_state = 'closed');
end; $$;

select test_set_current_user('a2000001-0000-0000-0000-000000000005'); -- sales-a2, assigned to conv 6, no conversations.close
select test_assert_raises(
  'sales_person cannot End Human Assistance even when it is the assigned member -- no assigned-member bypass',
  $sql$ select handover_end_human_assistance('d2000001-0000-0000-0000-000000000006') $sql$,
  'permission_denied'
);
select test_assert_raises(
  'sales_person cannot Close a Conversation even when it is the assigned member',
  $sql$ select handover_close_conversation('d2000001-0000-0000-0000-000000000006') $sql$,
  'permission_denied'
);

select test_set_current_user('a2000001-0000-0000-0000-000000000006'); -- accounts-a2, not a conversation participant at all
select test_assert_raises(
  'company_accounts cannot Close a Conversation (no conversations.close, no conversations.assign)',
  $sql$ select handover_close_conversation('d2000001-0000-0000-0000-000000000006') $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 7. Pause/Resume AI regression: untouched by the conversations.close split
--    -- sales_person holds conversations.assign (unchanged) and can still
--    pause/resume AI on its own assigned conversation, with no dependency
--    on conversations.close (which it does not hold).
-- ---------------------------------------------------------------------------

select test_set_current_user('a2000001-0000-0000-0000-000000000005'); -- sales-a2
do $$
declare v_mode conversation_ai_mode; begin
  select ai_mode into v_mode from handover_pause_ai('d2000001-0000-0000-0000-000000000006');
  perform test_assert('sales_person (conversations.assign, no conversations.close) can still Pause AI on its own assigned conversation -- unaffected by the close/end split', v_mode = 'paused');
  select ai_mode into v_mode from handover_resume_ai('d2000001-0000-0000-0000-000000000006');
  perform test_assert('sales_person can still Resume AI on its own assigned conversation', v_mode = 'active');
end; $$;

reset role;

rollback;
