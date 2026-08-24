-- Phase 5: Client Support & Requests (migration 27) RLS/RPC hardening tests.
-- Run after rls_phone_direct_access_revoke.sql (via supabase/tests/run.sh),
-- against the same throwaway local Postgres database -- never a hosted
-- Supabase project.

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
-- Company A: owner + sales_person + company_accounts + a DEACTIVATED
-- sales_person (for the "deactivated member denied" assertion).
-- Company B: owner only, for cross-tenant assertions.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('f0000001-0000-0000-0000-000000000001', 'super-admin-sr@example.test'),
  ('f1000001-0000-0000-0000-000000000001', 'owner-a-sr@example.test'),
  ('f1000001-0000-0000-0000-000000000002', 'sales-a-sr@example.test'),
  ('f1000001-0000-0000-0000-000000000003', 'accounts-a-sr@example.test'),
  ('f1000001-0000-0000-0000-000000000004', 'deactivated-a-sr@example.test'),
  ('f2000001-0000-0000-0000-000000000001', 'owner-b-sr@example.test'),
  ('f0000002-0000-0000-0000-000000000001', 'platform-support-sr@example.test');

insert into platform_members (user_id, role, is_active) values
  ('f0000001-0000-0000-0000-000000000001', 'super_admin', true),
  ('f0000002-0000-0000-0000-000000000001', 'platform_support', true);

insert into companies (id, name, slug, status, is_demo) values
  ('c1000001-0000-0000-0000-000000000001', 'Support Req Co A', 'support-req-co-a', 'active', true),
  ('c2000001-0000-0000-0000-000000000001', 'Support Req Co B', 'support-req-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('a1000001-0000-0000-0000-000000000001', 'c1000001-0000-0000-0000-000000000001', 'f1000001-0000-0000-0000-000000000001', 'company_owner', true),
  ('a1000001-0000-0000-0000-000000000002', 'c1000001-0000-0000-0000-000000000001', 'f1000001-0000-0000-0000-000000000002', 'sales_person', true),
  ('a1000001-0000-0000-0000-000000000003', 'c1000001-0000-0000-0000-000000000001', 'f1000001-0000-0000-0000-000000000003', 'company_accounts', true),
  ('a1000001-0000-0000-0000-000000000004', 'c1000001-0000-0000-0000-000000000001', 'f1000001-0000-0000-0000-000000000004', 'sales_person', false),
  ('a2000001-0000-0000-0000-000000000001', 'c2000001-0000-0000-0000-000000000001', 'f2000001-0000-0000-0000-000000000001', 'company_owner', true);

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 1. Create: Company A owner creates a request. Reference is sequential,
--    zero-padded, SUP-prefixed. Priority defaults to normal; urgent/low are
--    rejected from this client-facing RPC.
-- ---------------------------------------------------------------------------

select test_set_current_user('f1000001-0000-0000-0000-000000000001'); -- owner-a

do $$
declare
  v_row record;
begin
  select * into v_row from create_support_request(
    'c1000001-0000-0000-0000-000000000001', 'technical_issue', 'App keeps crashing', 'It crashes every time I open conversations.', 'normal'
  );
  if v_row.reference !~ '^SUP-[0-9]{6}$' then
    raise exception 'ASSERTION FAILED: reference % does not match SUP-NNNNNN', v_row.reference;
  end if;
  if v_row.status <> 'open' then
    raise exception 'ASSERTION FAILED: new request status should default to open, got %', v_row.status;
  end if;
  raise notice 'OK: create_support_request returns a well-formed sequential reference and open status';
end;
$$;

select test_assert(
  'Company A now has exactly one support request',
  (select count(*) from support_requests where company_id = 'c1000001-0000-0000-0000-000000000001') = 1
);

select test_assert(
  'support_request_created is recorded in audit_logs',
  exists (select 1 from audit_logs where company_id = 'c1000001-0000-0000-0000-000000000001' and action = 'support_request_created')
);

select test_assert_raises_like(
  'a client cannot request urgent priority at creation time',
  $sql$ select * from create_support_request('c1000001-0000-0000-0000-000000000001', 'complaint', 'x', 'y', 'urgent') $sql$,
  'invalid_priority_for_client'
);

select test_assert_raises_like(
  'a client cannot request low priority at creation time',
  $sql$ select * from create_support_request('c1000001-0000-0000-0000-000000000001', 'complaint', 'x', 'y', 'low') $sql$,
  'invalid_priority_for_client'
);

select test_assert_raises_like(
  'a caller cannot create a request for a company they are not an active permitted member of',
  $sql$ select * from create_support_request('c2000001-0000-0000-0000-000000000001', 'complaint', 'x', 'y', 'normal') $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 2. Company Accounts can create and view own-company support (final plan
--    section 2's explicit finance/billing-request allowance).
-- ---------------------------------------------------------------------------

select test_set_current_user('f1000001-0000-0000-0000-000000000003'); -- company_accounts-a

do $$
begin
  perform create_support_request('c1000001-0000-0000-0000-000000000001', 'general_support', 'Invoice question', 'Where is my invoice for last month?', 'normal');
  raise notice 'OK: company_accounts can create a support request for their own company';
end;
$$;

select test_assert(
  'company_accounts can see requests for their own company',
  (select count(*) from support_requests where company_id = 'c1000001-0000-0000-0000-000000000001') >= 2
);

-- ---------------------------------------------------------------------------
-- 3. Deactivated member: denied.
-- ---------------------------------------------------------------------------

select test_set_current_user('f1000001-0000-0000-0000-000000000004'); -- deactivated sales_person

select test_assert_raises_like(
  'a deactivated member cannot create a support request',
  $sql$ select * from create_support_request('c1000001-0000-0000-0000-000000000001', 'complaint', 'x', 'y', 'normal') $sql$,
  'permission_denied'
);

select test_assert(
  'a deactivated member sees zero requests for their own (former) company',
  (select count(*) from support_requests where company_id = 'c1000001-0000-0000-0000-000000000001') = 0
);

-- ---------------------------------------------------------------------------
-- 4. Cross-tenant isolation: Company B cannot read or reply to Company A's
--    request.
-- ---------------------------------------------------------------------------

select test_set_current_user('f1000001-0000-0000-0000-000000000001'); -- owner-a (can see it, unlike the deactivated member above)

do $$
declare
  v_request_id uuid;
begin
  select id into v_request_id from support_requests where company_id = 'c1000001-0000-0000-0000-000000000001' order by created_at limit 1;
  perform set_config('test.request_a_id', v_request_id::text, false);
end;
$$;

select test_set_current_user('f2000001-0000-0000-0000-000000000001'); -- owner-b

select test_assert(
  'Company B cannot read Company A''s support request',
  not exists (select 1 from support_requests where id = current_setting('test.request_a_id')::uuid)
);

select test_assert(
  'Company B has zero support requests visible (its own company has none, and Company A''s are invisible)',
  (select count(*) from support_requests) = 0
);

select test_assert_raises_like(
  'Company B cannot reply to Company A''s support request',
  $sql$ select * from reply_support_request(current_setting('test.request_a_id')::uuid, 'trying to reply cross-tenant') $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 5. Company A client cannot set an internal note, change status, or
--    change priority -- these RPCs are is_platform_staff()-gated; an
--    ordinary company member (even the owner) is rejected regardless of
--    their company-level permissions.
-- ---------------------------------------------------------------------------

select test_set_current_user('f1000001-0000-0000-0000-000000000001'); -- owner-a

select test_assert_raises_like(
  'a client (even company_owner) cannot post an internal note -- admin_reply_support_request is platform-staff only',
  $sql$ select * from admin_reply_support_request(current_setting('test.request_a_id')::uuid, 'sneaky internal note', true) $sql$,
  'permission_denied'
);

select test_assert_raises_like(
  'a client cannot change status',
  $sql$ select * from admin_update_support_request_status(current_setting('test.request_a_id')::uuid, 'resolved') $sql$,
  'permission_denied'
);

select test_assert_raises_like(
  'a client cannot change priority',
  $sql$ select * from admin_update_support_request_priority(current_setting('test.request_a_id')::uuid, 'urgent') $sql$,
  'permission_denied'
);

select test_assert_raises_like(
  'a client cannot resolve their own request',
  $sql$ select * from admin_resolve_support_request(current_setting('test.request_a_id')::uuid) $sql$,
  'permission_denied'
);

select test_assert_raises_like(
  'a client cannot assign their own request to platform staff',
  $sql$ select * from admin_assign_support_request(current_setting('test.request_a_id')::uuid, null) $sql$,
  'permission_denied'
);

-- Client reply, by contrast, is allowed and is client-visible (never internal).
do $$
begin
  perform reply_support_request(current_setting('test.request_a_id')::uuid, 'Any update on this?');
  raise notice 'OK: the request creator''s own company can reply to their own request';
end;
$$;

select test_assert(
  'the client reply is recorded as author_type=client, is_internal=false',
  exists (
    select 1 from support_request_messages
    where request_id = current_setting('test.request_a_id')::uuid
      and author_type = 'client' and is_internal = false and message = 'Any update on this?'
  )
);

select test_assert(
  'support_request_replied is recorded in audit_logs for the client reply',
  exists (select 1 from audit_logs where action = 'support_request_replied' and target_id = current_setting('test.request_a_id')::text)
);

-- ---------------------------------------------------------------------------
-- 6. Super Admin / platform staff: can view and manage every company's
--    requests, including status transitions, priority, assignment, and
--    internal notes.
-- ---------------------------------------------------------------------------

select test_set_current_user('f0000001-0000-0000-0000-000000000001'); -- super_admin

select test_assert(
  'Super Admin sees every company''s support requests',
  (select count(*) from support_requests) >= 2
);

do $$
begin
  perform admin_reply_support_request(current_setting('test.request_a_id')::uuid, 'This is an internal-only note.', true);
  perform admin_reply_support_request(current_setting('test.request_a_id')::uuid, 'We are looking into this.', false);
  raise notice 'OK: platform staff can post both an internal note and a public reply';
end;
$$;

select test_assert(
  'the internal note is recorded is_internal=true, author_type=platform',
  exists (
    select 1 from support_request_messages
    where request_id = current_setting('test.request_a_id')::uuid
      and author_type = 'platform' and is_internal = true and message = 'This is an internal-only note.'
  )
);

select test_assert(
  'support_request_internal_note_added is recorded in audit_logs',
  exists (select 1 from audit_logs where action = 'support_request_internal_note_added' and target_id = current_setting('test.request_a_id')::text)
);

select test_assert(
  'a not-platform-staff user other than platform_support also has full access (any active platform role, not just super_admin)',
  true -- exercised concretely below via platform_support
);

select test_set_current_user('f0000002-0000-0000-0000-000000000001'); -- platform_support (not super_admin)

do $$
begin
  perform admin_update_support_request_priority(current_setting('test.request_a_id')::uuid, 'high');
  perform admin_assign_support_request(current_setting('test.request_a_id')::uuid, 'f0000002-0000-0000-0000-000000000001');
  raise notice 'OK: platform_support (not super_admin) can update priority and self-assign';
end;
$$;

select test_assert(
  'priority is now high, assigned to platform_support',
  (select priority::text from support_requests where id = current_setting('test.request_a_id')::uuid) = 'high'
  and (select assigned_platform_user_id from support_requests where id = current_setting('test.request_a_id')::uuid) = 'f0000002-0000-0000-0000-000000000001'
);

select test_assert(
  'support_request_priority_changed and support_request_assigned are both recorded in audit_logs',
  exists (select 1 from audit_logs where action = 'support_request_priority_changed' and target_id = current_setting('test.request_a_id')::text)
  and exists (select 1 from audit_logs where action = 'support_request_assigned' and target_id = current_setting('test.request_a_id')::text)
);

-- ---------------------------------------------------------------------------
-- 7. Status transitions: 'resolved' is rejected from the generic status
--    RPC (must use admin_resolve_support_request); resolve then reopen
--    round-trips correctly; a closed request cannot skip straight back to
--    waiting_on_client.
-- ---------------------------------------------------------------------------

select test_assert_raises_like(
  'admin_update_support_request_status rejects p_status=resolved directly (use_resolve_action)',
  $sql$ select * from admin_update_support_request_status(current_setting('test.request_a_id')::uuid, 'resolved') $sql$,
  'use_resolve_action'
);

do $$
begin
  perform admin_resolve_support_request(current_setting('test.request_a_id')::uuid);
end;
$$;

select test_assert(
  'admin_resolve_support_request sets status=resolved and stamps resolved_at',
  (select status::text from support_requests where id = current_setting('test.request_a_id')::uuid) = 'resolved'
  and (select resolved_at from support_requests where id = current_setting('test.request_a_id')::uuid) is not null
);

select test_assert_raises_like(
  'a resolved request cannot skip straight to waiting_on_client (must reopen first)',
  $sql$ select * from admin_update_support_request_status(current_setting('test.request_a_id')::uuid, 'waiting_on_client') $sql$,
  'invalid_state_transition'
);

do $$
begin
  perform admin_update_support_request_status(current_setting('test.request_a_id')::uuid, 'closed');
end;
$$;

select test_assert(
  'a resolved request CAN move directly to closed via the generic status RPC',
  (select status::text from support_requests where id = current_setting('test.request_a_id')::uuid) = 'closed'
);

select test_assert_raises_like(
  'a closed request rejects any further status update via the generic RPC (must reopen first)',
  $sql$ select * from admin_update_support_request_status(current_setting('test.request_a_id')::uuid, 'open') $sql$,
  'invalid_state_transition'
);

do $$
begin
  perform admin_reopen_support_request(current_setting('test.request_a_id')::uuid);
end;
$$;

select test_assert(
  'admin_reopen_support_request moves a closed request back to in_progress and clears resolved_at',
  (select status::text from support_requests where id = current_setting('test.request_a_id')::uuid) = 'in_progress'
  and (select resolved_at from support_requests where id = current_setting('test.request_a_id')::uuid) is null
);

select test_assert_raises_like(
  'admin_reopen_support_request rejects a request that is not resolved/closed',
  $sql$ select * from admin_reopen_support_request(current_setting('test.request_a_id')::uuid) $sql$,
  'invalid_state_transition'
);

-- ---------------------------------------------------------------------------
-- 8. Message visibility (final plan section 26).
-- ---------------------------------------------------------------------------

select test_set_current_user('f1000001-0000-0000-0000-000000000001'); -- owner-a (client, same company as the request)

select test_assert(
  'the client sees their own message and the platform''s public reply, but never the internal note',
  (select count(*) from support_request_messages where request_id = current_setting('test.request_a_id')::uuid and message = 'Any update on this?') = 1
  and (select count(*) from support_request_messages where request_id = current_setting('test.request_a_id')::uuid and message = 'We are looking into this.') = 1
  and (select count(*) from support_request_messages where request_id = current_setting('test.request_a_id')::uuid and is_internal = true) = 0
);

select test_set_current_user('f2000001-0000-0000-0000-000000000001'); -- owner-b (different company)

select test_assert(
  'a different company can never see Company A''s request messages at all',
  (select count(*) from support_request_messages where request_id = current_setting('test.request_a_id')::uuid) = 0
);

select test_set_current_user('f0000001-0000-0000-0000-000000000001'); -- super_admin

select test_assert(
  'Super Admin sees every message, including the internal note',
  (select count(*) from support_request_messages where request_id = current_setting('test.request_a_id')::uuid) >= 3
  and (select count(*) from support_request_messages where request_id = current_setting('test.request_a_id')::uuid and is_internal = true) = 1
);

-- A client reply while waiting_on_client auto-reopens into 'open' (the one
-- system-driven status transition a client reply is allowed to cause).
do $$
begin
  perform admin_update_support_request_status(current_setting('test.request_a_id')::uuid, 'waiting_on_client');
end;
$$;

select test_set_current_user('f1000001-0000-0000-0000-000000000001'); -- owner-a

do $$
begin
  perform reply_support_request(current_setting('test.request_a_id')::uuid, 'Here is the info you asked for.');
end;
$$;

select test_assert(
  'a client reply while waiting_on_client automatically reopens the request to open',
  (select status::text from support_requests where id = current_setting('test.request_a_id')::uuid) = 'open'
);

-- ---------------------------------------------------------------------------
-- 9. Company deletion preserves support history (company_id SET NULL, not
--    CASCADE) -- Super Admin can still see the orphaned request.
-- ---------------------------------------------------------------------------

select test_set_current_user('f0000001-0000-0000-0000-000000000001'); -- super_admin

-- Company lifecycle deletion has no direct-table RLS policy for
-- `authenticated` at all (real company deletion, if ever exposed, would go
-- through its own SECURITY DEFINER RPC) -- resetting to the superuser role
-- here isolates this assertion to the FK behavior itself, exactly like
-- rls_role_team_security.sql's own direct-insert exercise of the
-- one-active-owner constraint.
reset role;

do $$
declare
  v_request_id uuid := current_setting('test.request_a_id')::uuid;
  v_message_count_before integer;
begin
  select count(*) into v_message_count_before from support_request_messages where request_id = v_request_id;

  delete from companies where id = 'c1000001-0000-0000-0000-000000000001';

  if not exists (select 1 from support_requests where id = v_request_id) then
    raise exception 'ASSERTION FAILED: support_requests row was destroyed by company deletion (should be company_id SET NULL, not CASCADE)';
  end if;
  if (select company_id from support_requests where id = v_request_id) is not null then
    raise exception 'ASSERTION FAILED: company_id was not set to null after company deletion';
  end if;
  if (select count(*) from support_request_messages where request_id = v_request_id) <> v_message_count_before then
    raise exception 'ASSERTION FAILED: support_request_messages rows were lost when the request survived company deletion';
  end if;
  raise notice 'OK: deleting a company sets support_requests.company_id to null instead of destroying the request or its messages';
end;
$$;

reset role;

do $$
begin
  raise notice 'All Phase 5 Client Support & Requests RLS/RPC assertions passed.';
end;
$$;

rollback;
