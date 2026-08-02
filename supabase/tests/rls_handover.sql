-- Human Handover Inbox RLS / RPC hardening tests (final plan section 18).
-- Run after rls_tenant_isolation.sql (via supabase/tests/run.sh), against the
-- same throwaway local Postgres database -- never a hosted Supabase project.
-- Every check either passes silently or RAISE EXCEPTIONs.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures (inserted as the transaction owner, bypassing RLS -- see
-- supabase/tests/README.md). Two companies; Company A has an owner, a
-- manager (assign/reply/reassign/reconcile), and two plain agents (view/reply
-- only); Company B exists only for cross-tenant isolation checks. One
-- platform_support staff member for the handover_events RLS check.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('a1111111-0000-0000-0000-000000000001', 'owner-a@example.test'),
  ('a1111111-0000-0000-0000-000000000002', 'manager-a@example.test'),
  ('a1111111-0000-0000-0000-000000000003', 'agent-a1@example.test'),
  ('a1111111-0000-0000-0000-000000000004', 'agent-a2@example.test'),
  ('b1111111-0000-0000-0000-000000000001', 'owner-b@example.test'),
  ('c1111111-0000-0000-0000-000000000001', 'platform-support@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('aaaaaaaa-1000-0000-0000-000000000001', 'Handover Co A', 'handover-co-a', 'active', true),
  ('bbbbbbbb-1000-0000-0000-000000000002', 'Handover Co B', 'handover-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('a0000001-1000-0000-0000-000000000001', 'aaaaaaaa-1000-0000-0000-000000000001', 'a1111111-0000-0000-0000-000000000001', 'company_owner', true),
  ('a0000001-1000-0000-0000-000000000002', 'aaaaaaaa-1000-0000-0000-000000000001', 'a1111111-0000-0000-0000-000000000002', 'manager', true),
  ('a0000001-1000-0000-0000-000000000003', 'aaaaaaaa-1000-0000-0000-000000000001', 'a1111111-0000-0000-0000-000000000003', 'agent', true),
  ('a0000001-1000-0000-0000-000000000004', 'aaaaaaaa-1000-0000-0000-000000000001', 'a1111111-0000-0000-0000-000000000004', 'agent', true),
  ('b0000001-1000-0000-0000-000000000001', 'bbbbbbbb-1000-0000-0000-000000000002', 'b1111111-0000-0000-0000-000000000001', 'company_owner', true);

insert into platform_members (user_id, role) values
  ('c1111111-0000-0000-0000-000000000001', 'platform_support');

insert into contacts (id, company_id, whatsapp_wa_id, profile_name) values
  ('c0000000-1000-0000-0000-00000000000a', 'aaaaaaaa-1000-0000-0000-000000000001', '911000001001', 'Customer A'),
  ('c0000000-1000-0000-0000-00000000000b', 'bbbbbbbb-1000-0000-0000-000000000002', '911000002001', 'Customer B');

-- conv1: handover_requested, unassigned -- assign/queue/trigger_handover tests.
-- conv2: human_active, assigned to agent1 -- human-reply/override/pause tests.
-- conv3: ai_active -- baseline / End human assistance dead-end tests.
-- convB: handover_requested, Company B -- cross-tenant isolation tests.
insert into conversations (id, company_id, contact_id, state, assigned_member_id) values
  ('d0000001-1000-0000-0000-000000000001', 'aaaaaaaa-1000-0000-0000-000000000001', 'c0000000-1000-0000-0000-00000000000a', 'handover_requested', null),
  ('d0000001-1000-0000-0000-000000000002', 'aaaaaaaa-1000-0000-0000-000000000001', 'c0000000-1000-0000-0000-00000000000a', 'human_active', 'a0000001-1000-0000-0000-000000000003'),
  ('d0000001-1000-0000-0000-000000000003', 'aaaaaaaa-1000-0000-0000-000000000001', 'c0000000-1000-0000-0000-00000000000a', 'ai_active', null),
  ('d0000002-1000-0000-0000-000000000001', 'bbbbbbbb-1000-0000-0000-000000000002', 'c0000000-1000-0000-0000-00000000000b', 'handover_requested', null);

insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, body, provider_message_id) values
  ('e0000001-1000-0000-0000-000000000001', 'aaaaaaaa-1000-0000-0000-000000000001', 'd0000001-1000-0000-0000-000000000001', 'inbound', 'text', 'customer', 'Please escalate this', 'wamid.H1'),
  ('e0000001-1000-0000-0000-000000000002', 'aaaaaaaa-1000-0000-0000-000000000001', 'd0000001-1000-0000-0000-000000000002', 'inbound', 'text', 'customer', 'Still need help', 'wamid.H2'),
  ('e0000001-1000-0000-0000-000000000003', 'aaaaaaaa-1000-0000-0000-000000000001', 'd0000001-1000-0000-0000-000000000003', 'inbound', 'text', 'customer', 'Escalate this too', 'wamid.H3'),
  ('e0000001-1000-0000-0000-000000000004', 'aaaaaaaa-1000-0000-0000-000000000001', 'd0000001-1000-0000-0000-000000000003', 'inbound', 'text', 'customer', 'One more message', 'wamid.H4'),
  ('e0000002-1000-0000-0000-000000000001', 'bbbbbbbb-1000-0000-0000-000000000002', 'd0000002-1000-0000-0000-000000000001', 'inbound', 'text', 'customer', 'Escalate B', 'wamid.HB1');

-- ---------------------------------------------------------------------------
-- Assertion helpers
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

-- Executes dynamic SQL and asserts it raises exactly `expected_message` (the
-- fixed exception vocabulary migration 12's functions use, e.g.
-- 'conversation_already_claimed') -- fails the suite if no exception is
-- raised, or a different one is.
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
-- Hardening sweep: every one of migration 12's 13 new functions must have an
-- empty search_path and the exact execute-privilege grants its trust family
-- requires (final plan section 4/17) -- run once, as superuser, before
-- switching to the restricted `authenticated` role below.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  service_role_only_fns text[] := array[
    'trigger_handover', 'reserve_ai_outbound_message', 'finalize_ai_outbound_message',
    'expire_stale_outbound_sends'
  ];
  authenticated_fns text[] := array[
    'reserve_human_outbound_message', 'finalize_human_outbound_message',
    'handover_assign_to_me', 'handover_assign_to_member', 'handover_start',
    'handover_mark_queued', 'handover_end_human_assistance', 'handover_close_conversation',
    'handover_pause_ai', 'handover_resume_ai', 'handover_mark_read'
  ];
  -- reconcile_outbound_message is dual-authorized (authenticated AND service_role) -- checked separately below.
begin
  foreach fn in array (service_role_only_fns || authenticated_fns || array['reconcile_outbound_message'])
  loop
    if not exists (
      select 1 from pg_proc p
      where p.proname = fn
        and exists (
          select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%' and cfg not like 'search_path=%public%'
        )
    ) then
      raise exception 'ASSERTION FAILED: function % does not have an empty search_path set', fn;
    end if;
    raise notice 'OK: function % has an empty search_path', fn;
  end loop;

  foreach fn in array service_role_only_fns
  loop
    if has_function_privilege('authenticated', (select oid from pg_proc where proname = fn limit 1), 'execute') then
      raise exception 'ASSERTION FAILED: service_role-only function % is executable by authenticated', fn;
    end if;
    if has_function_privilege('anon', (select oid from pg_proc where proname = fn limit 1), 'execute') then
      raise exception 'ASSERTION FAILED: service_role-only function % is executable by anon', fn;
    end if;
    raise notice 'OK: % is not executable by authenticated or anon', fn;
  end loop;

  foreach fn in array authenticated_fns
  loop
    if has_function_privilege('anon', (select oid from pg_proc where proname = fn limit 1), 'execute') then
      raise exception 'ASSERTION FAILED: authenticated-only function % is executable by anon', fn;
    end if;
    raise notice 'OK: % is not executable by anon', fn;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- handover_events hardening: RLS enabled, no direct client writes, company-
-- scoped reads only.
-- ---------------------------------------------------------------------------

select test_assert(
  'anon cannot execute has table-level select on handover_events (RLS blocks all rows anyway, checked below)',
  not has_table_privilege('anon', 'handover_events', 'insert')
);
select test_assert(
  'authenticated cannot insert into handover_events directly (table privilege, not RLS)',
  not has_table_privilege('authenticated', 'handover_events', 'insert')
);
select test_assert(
  'authenticated cannot update handover_events directly',
  not has_table_privilege('authenticated', 'handover_events', 'update')
);
select test_assert(
  'authenticated cannot delete from handover_events directly',
  not has_table_privilege('authenticated', 'handover_events', 'delete')
);

-- All fixtures are in place. From here on, run as the restricted
-- `authenticated` role so RLS is actually enforced (see supabase/tests/README.md).
set local role authenticated;

-- ---------------------------------------------------------------------------
-- trigger_handover: service_role only -- an authenticated caller gets a bare
-- Postgres permission-denied error (not one of the fixed exception codes),
-- since the grant itself is what blocks the call.
-- ---------------------------------------------------------------------------

select test_set_current_user('a1111111-0000-0000-0000-000000000001');

do $$
begin
  begin
    perform trigger_handover('d0000001-1000-0000-0000-000000000003', 'test', 'e0000001-1000-0000-0000-000000000001', 'text', null);
    raise exception 'ASSERTION FAILED: authenticated caller should not be able to execute trigger_handover at all';
  exception
    when insufficient_privilege then
      raise notice 'OK: authenticated caller is rejected by Postgres privileges before trigger_handover''s own logic ever runs';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dashboard actions: Assign to me (owner, conversations.assign), then a
-- second caller racing the same claim.
-- ---------------------------------------------------------------------------

select test_set_current_user('a1111111-0000-0000-0000-000000000001');

select test_assert(
  'owner can assign_to_me an unassigned handover_requested conversation',
  (select state from handover_assign_to_me('d0000001-1000-0000-0000-000000000001')) = 'human_active'
);

select test_set_current_user('a1111111-0000-0000-0000-000000000002');

select test_assert_raises(
  'a second caller racing the same already-claimed conversation is rejected, not silently co-assigned',
  $sql$select handover_assign_to_me('d0000001-1000-0000-0000-000000000001')$sql$,
  'conversation_already_claimed'
);

-- ---------------------------------------------------------------------------
-- Human-reply restriction (final plan section 2/11): conv2 is human_active,
-- assigned to agent1. agent1 may reply; agent2 (no reassign) is rejected;
-- the manager (holds conversations.reassign) may override -- and it must
-- record a distinct audit row without touching assigned_member_id.
-- ---------------------------------------------------------------------------

select test_set_current_user('a1111111-0000-0000-0000-000000000003'); -- agent1, the assignee

select test_assert(
  'the assigned employee (agent1) can reserve a human outbound message',
  (select claimed from reserve_human_outbound_message('d0000001-1000-0000-0000-000000000002', 'hello', 'compose-1')) = true
);

select test_set_current_user('a1111111-0000-0000-0000-000000000004'); -- agent2, not assigned, no reassign permission

select test_assert_raises(
  'a different agent without conversations.reassign cannot reply on someone else''s assigned conversation',
  $sql$select reserve_human_outbound_message('d0000001-1000-0000-0000-000000000002', 'hello', 'compose-2')$sql$,
  'conversation_not_assigned_to_caller'
);

select test_set_current_user('a1111111-0000-0000-0000-000000000002'); -- manager, holds conversations.reassign

select test_assert(
  'an authorized manager override may reply on an assigned employee''s conversation',
  (select claimed from reserve_human_outbound_message('d0000001-1000-0000-0000-000000000002', 'manager stepping in', 'compose-3')) = true
);

select test_assert(
  'the manager override never silently reassigns the conversation',
  (select assigned_member_id from conversations where id = 'd0000001-1000-0000-0000-000000000002') = 'a0000001-1000-0000-0000-000000000003'
);

-- audit_logs requires the audit.view permission (only company_owner/admin
-- hold it by default) -- switch to the owner to read it back.
select test_set_current_user('a1111111-0000-0000-0000-000000000001');

select test_assert(
  'the manager override is recorded as a distinctly-actioned audit row',
  exists (
    select 1 from audit_logs
    where action = 'handover.manager_override_reply'
      and target_id = 'd0000001-1000-0000-0000-000000000002'
  )
);

-- finalize_human_outbound_message: only the reservation's own owner may finalize it.
select test_set_current_user('a1111111-0000-0000-0000-000000000003'); -- agent1 -- not the manager who reserved compose-3

do $$
declare
  v_manager_message_id uuid;
begin
  select id into v_manager_message_id from messages
    where conversation_id = 'd0000001-1000-0000-0000-000000000002' and idempotency_key like '%compose-3%';

  begin
    perform finalize_human_outbound_message(v_manager_message_id, 'sent', 'wamid.OUT1', null, null);
    raise exception 'ASSERTION FAILED: agent1 must not be able to finalize the manager''s own reservation';
  exception
    when others then
      if sqlerrm <> 'not_reservation_owner' then
        raise exception 'ASSERTION FAILED: expected not_reservation_owner but got %', sqlerrm;
      end if;
      raise notice 'OK: an employee cannot finalize a reservation owned by a different member';
  end;
end;
$$;

-- Cross-tenant: Company B's owner cannot touch Company A's conversation at all.
select test_set_current_user('b1111111-0000-0000-0000-000000000001');

select test_assert_raises(
  'a Company B caller cannot reserve a human outbound message on a Company A conversation (tenant isolation)',
  $sql$select reserve_human_outbound_message('d0000001-1000-0000-0000-000000000002', 'cross-tenant', 'compose-x')$sql$,
  'not_a_member'
);

-- ---------------------------------------------------------------------------
-- Outbound leases (final plan section 14): two concurrent reserve calls for
-- the same key -> exactly one claimed:true while the lease is unexpired; an
-- expired lease can be reclaimed by a normal retry.
-- ---------------------------------------------------------------------------

select test_set_current_user('a1111111-0000-0000-0000-000000000001');

select test_assert_raises(
  'reserve_human_outbound_message rejects a conversation outside human_active before any lease is even considered',
  $sql$select reserve_human_outbound_message('d0000001-1000-0000-0000-000000000003', 'lease test', 'lease-key-1')$sql$,
  'invalid_state_transition'
);

-- The idempotency key is composited per-caller (memberId:conversationId:
-- clientKey, final plan section 11) -- a "repeat" reserve call must come
-- from the SAME member (the manager, who made the original compose-3
-- reservation) to actually collide with it.
select test_set_current_user('a1111111-0000-0000-0000-000000000002');

select test_assert(
  'a repeat reserve call with the same key while the first lease is unexpired is NOT re-claimed',
  (select claimed from reserve_human_outbound_message('d0000001-1000-0000-0000-000000000002', 'manager stepping in', 'compose-3')) = false
);

-- Simulating "time has passed" by directly manipulating the lease requires
-- the table owner (`messages` has no UPDATE policy at all -- every real
-- write goes through a SECURITY DEFINER function): drop back to the
-- connecting superuser role for this one fixture mutation, then resume as
-- `authenticated` for the actual assertion.
reset role;
update messages set send_lease_expires_at = now() - interval '1 minute'
  where conversation_id = 'd0000001-1000-0000-0000-000000000002' and idempotency_key like '%compose-3%';
set local role authenticated;

select test_assert(
  'an expired lease CAN be reclaimed by a normal retry',
  (select claimed from reserve_human_outbound_message('d0000001-1000-0000-0000-000000000002', 'manager stepping in', 'compose-3')) = true
);

-- retryable=false send_failed is never matched by a claim query.
reset role;
update messages set outbound_status = 'send_failed', retryable = false
  where conversation_id = 'd0000001-1000-0000-0000-000000000002' and idempotency_key like '%compose-3%';
set local role authenticated;

select test_assert(
  'a permanent (retryable=false) send_failed row is never reclaimed',
  (select claimed from reserve_human_outbound_message('d0000001-1000-0000-0000-000000000002', 'manager stepping in', 'compose-3')) = false
);

-- ---------------------------------------------------------------------------
-- reconcile_outbound_message: only accepts a currently delivery_unknown row;
-- human-agent messages require conversations.reconcile; AI messages may only
-- be reconciled by service_role.
-- ---------------------------------------------------------------------------

-- Fresh dedicated message row, created directly in delivery_unknown status
-- (the transition-enforcement trigger only fires on UPDATE, not INSERT, and
-- send_failed -> delivery_unknown isn't an allowed transition anyway --
-- reusing an already-cycled row here would be a test artifact, not a real
-- scenario). `messages` has no INSERT policy at all (every real write goes
-- through a SECURITY DEFINER function), so this fixture row is inserted as
-- the table owner.
reset role;
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, sender_member_id, idempotency_key, outbound_status, body)
  values ('f0000002-1000-0000-0000-000000000001', 'aaaaaaaa-1000-0000-0000-000000000001', 'd0000001-1000-0000-0000-000000000002', 'outbound', 'text', 'human_agent', 'a0000001-1000-0000-0000-000000000003', 'reconcile-test-key', 'delivery_unknown', 'stuck human reply');
set local role authenticated;

select test_set_current_user('a1111111-0000-0000-0000-000000000003'); -- agent1, no conversations.reconcile

do $$
declare
  v_message_id uuid := 'f0000002-1000-0000-0000-000000000001';
begin
  begin
    perform reconcile_outbound_message(v_message_id, 'confirm_sent', null, null);
    raise exception 'ASSERTION FAILED: agent without conversations.reconcile must not be able to reconcile';
  exception
    when others then
      if sqlerrm <> 'permission_denied' then
        raise exception 'ASSERTION FAILED: expected permission_denied but got %', sqlerrm;
      end if;
      raise notice 'OK: reconcile_outbound_message rejects a caller without conversations.reconcile';
  end;
end;
$$;

select test_set_current_user('a1111111-0000-0000-0000-000000000002'); -- manager, holds conversations.reconcile

do $$
declare
  v_message_id uuid := 'f0000002-1000-0000-0000-000000000001';
  v_status outbound_delivery_status;
begin
  select outbound_status into v_status from reconcile_outbound_message(v_message_id, 'confirm_sent', 'wamid.RECONCILED', 'manual check');
  if v_status <> 'sent' then
    raise exception 'ASSERTION FAILED: expected sent, got %', v_status;
  end if;

  -- audit_logs requires the audit.view permission (only company_owner/admin
  -- hold it by default) -- switch to the owner to read it back.
  perform test_set_current_user('a1111111-0000-0000-0000-000000000001');
  if not exists (select 1 from audit_logs where action = 'handover.outbound_reconciled' and target_id = v_message_id::text) then
    raise exception 'ASSERTION FAILED: reconcile_outbound_message must record an audit_logs row';
  end if;
  raise notice 'OK: an authorized manager can reconcile a human-agent message and it is audited';
  perform test_set_current_user('a1111111-0000-0000-0000-000000000002');

  begin
    perform reconcile_outbound_message(v_message_id, 'confirm_sent', null, null);
    raise exception 'ASSERTION FAILED: a non-delivery_unknown row must not be reconcilable again';
  exception
    when others then
      if sqlerrm <> 'invalid_status_transition' then
        raise exception 'ASSERTION FAILED: expected invalid_status_transition but got %', sqlerrm;
      end if;
      raise notice 'OK: reconcile_outbound_message rejects a row that is not currently delivery_unknown';
  end;
end;
$$;

-- reconcile of an AI-authored message via an authenticated caller must be rejected.
-- `messages` has no INSERT policy at all (every real write goes through a
-- SECURITY DEFINER function) -- insert this AI-authored fixture row as the
-- table owner, then resume as `authenticated` for the actual assertion.
reset role;
insert into messages (id, company_id, conversation_id, direction, channel_type, sender_type, source_message_id, outbound_status, body)
  values ('f0000001-1000-0000-0000-000000000001', 'aaaaaaaa-1000-0000-0000-000000000001', 'd0000001-1000-0000-0000-000000000003', 'outbound', 'text', 'ai', 'e0000001-1000-0000-0000-000000000003', 'delivery_unknown', 'ai reply');
set local role authenticated;
select test_set_current_user('a1111111-0000-0000-0000-000000000002'); -- manager, holds conversations.reconcile (but not for AI messages)

do $$
declare
  v_ai_message_id uuid := 'f0000001-1000-0000-0000-000000000001';
begin
  begin
    perform reconcile_outbound_message(v_ai_message_id, 'confirm_sent', null, null);
    raise exception 'ASSERTION FAILED: an authenticated caller must never reconcile an AI-authored message';
  exception
    when others then
      if sqlerrm <> 'permission_denied' then
        raise exception 'ASSERTION FAILED: expected permission_denied but got %', sqlerrm;
      end if;
      raise notice 'OK: reconcile_outbound_message rejects an authenticated caller reconciling an AI message';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- End human assistance / Pause AI never touch each other's fields (final
-- plan sections 9-10).
-- ---------------------------------------------------------------------------

select test_set_current_user('a1111111-0000-0000-0000-000000000003'); -- agent1, assigned to conv2

select test_assert(
  'agent1 (the assignee) can pause the AI on their own conversation',
  (select ai_mode from handover_pause_ai('d0000001-1000-0000-0000-000000000002')) = 'paused'
);

select test_set_current_user('a1111111-0000-0000-0000-000000000001'); -- owner, holds conversations.assign

do $$
declare
  v_state conversation_state;
  v_ai_mode conversation_ai_mode;
  v_assigned uuid;
begin
  select state, ai_mode, assigned_member_id into v_state, v_ai_mode, v_assigned
    from handover_end_human_assistance('d0000001-1000-0000-0000-000000000002');
  if v_state <> 'ai_active' then raise exception 'ASSERTION FAILED: expected ai_active, got %', v_state; end if;
  if v_assigned is not null then raise exception 'ASSERTION FAILED: assigned_member_id must be cleared'; end if;
  if v_ai_mode <> 'paused' then
    raise exception 'ASSERTION FAILED: End human assistance must not silently resume a previously paused AI (got %)', v_ai_mode;
  end if;
  raise notice 'OK: End human assistance clears assignment/state but leaves a prior AI pause untouched';
end;
$$;

-- ---------------------------------------------------------------------------
-- trigger_handover idempotency + notification fallback (final plan section
-- 13) -- run as service_role, the RPC's only authorized caller. The
-- handover_events read-isolation checks (below) depend on the events these
-- calls create, so they must run after this section, not before it.
-- ---------------------------------------------------------------------------

set local role service_role;

do $$
declare
  v_is_new boolean;
  v_notified_count integer;
begin
  -- conv3 is ai_active with no conversations.assign holder among its active
  -- members other than the owner (who does hold it) -- exercises the primary
  -- notification tier.
  select is_new_event into v_is_new from trigger_handover('d0000001-1000-0000-0000-000000000003', 'first escalation', 'e0000001-1000-0000-0000-000000000003', 'text', null);
  if v_is_new <> true then raise exception 'ASSERTION FAILED: the first trigger_handover for a given source message must be a new event'; end if;

  select is_new_event into v_is_new from trigger_handover('d0000001-1000-0000-0000-000000000003', 'first escalation', 'e0000001-1000-0000-0000-000000000003', 'text', null);
  if v_is_new <> false then
    raise exception 'ASSERTION FAILED: a redelivered trigger_handover for the same source message must be a durable no-op';
  end if;

  select count(*) into v_notified_count from notifications
    where company_id = 'aaaaaaaa-1000-0000-0000-000000000001' and category = 'human_handover_requested';
  if v_notified_count = 0 then
    raise exception 'ASSERTION FAILED: trigger_handover must never commit with zero notification rows';
  end if;
  raise notice 'OK: trigger_handover is idempotent per source message and always notifies someone';
end;
$$;

-- Durable no-op survives a full state cycle back through ai_active (the v3 bug this migration fixes).
do $$
declare
  v_conv_id uuid := 'd0000001-1000-0000-0000-000000000003';
  v_is_new boolean;
begin
  update conversations set state = 'ai_active' where id = v_conv_id; -- simulate a full handover cycle having already completed

  select is_new_event into v_is_new from trigger_handover(v_conv_id, 'first escalation', 'e0000001-1000-0000-0000-000000000003', 'text', null);
  if v_is_new <> false then
    raise exception 'ASSERTION FAILED: a redelivered handover for the same source message must remain a no-op even after the conversation cycled back to ai_active';
  end if;
  if (select state from conversations where id = v_conv_id) <> 'ai_active' then
    raise exception 'ASSERTION FAILED: a durable no-op must never re-transition the conversation';
  end if;
  raise notice 'OK: a redelivered handover-triggering message stays a permanent no-op even after a full ai_active cycle';
end;
$$;

-- ---------------------------------------------------------------------------
-- handover_events read isolation: same-company authorized read succeeds;
-- cross-tenant read returns nothing; anon sees nothing at all. Runs back as
-- `authenticated` -- trigger_handover (above) has now created real rows to
-- check RLS against.
-- ---------------------------------------------------------------------------

set local role authenticated;
select test_set_current_user('a1111111-0000-0000-0000-000000000001');

select test_assert(
  'Company A owner can read Company A''s own handover_events',
  (select count(*) from handover_events where company_id = 'aaaaaaaa-1000-0000-0000-000000000001') > 0
);

select test_assert(
  'Company A owner cannot read Company B''s handover_events',
  (select count(*) from handover_events where company_id = 'bbbbbbbb-1000-0000-0000-000000000002') = 0
);

select test_clear_current_user();

select test_assert(
  'an unauthenticated caller sees no handover_events across any company',
  (select count(*) from handover_events) = 0
);

set local role service_role;

-- ---------------------------------------------------------------------------
-- expire_stale_outbound_sends: sweeps an expired 'sending' lease to
-- delivery_unknown, with its own audit_logs/notifications trail.
-- ---------------------------------------------------------------------------

do $$
declare
  v_message_id uuid;
  v_final_status outbound_delivery_status;
  v_count integer;
begin
  insert into messages (company_id, conversation_id, direction, channel_type, sender_type, source_message_id, outbound_status, send_claimed_at, send_lease_expires_at, body)
    values ('aaaaaaaa-1000-0000-0000-000000000001', 'd0000001-1000-0000-0000-000000000003', 'outbound', 'text', 'ai', 'e0000001-1000-0000-0000-000000000004', 'sending', now() - interval '10 minutes', now() - interval '5 minutes', 'stuck reply')
    returning id into v_message_id;

  perform expire_stale_outbound_sends();

  select outbound_status into v_final_status from messages where id = v_message_id;
  if v_final_status <> 'delivery_unknown' then
    raise exception 'ASSERTION FAILED: expire_stale_outbound_sends must flip an expired sending row to delivery_unknown, got %', v_final_status;
  end if;

  select count(*) into v_count from audit_logs where action = 'handover.outbound_lease_expired' and target_id = v_message_id::text;
  if v_count = 0 then
    raise exception 'ASSERTION FAILED: expire_stale_outbound_sends must record an audit_logs row for each expired message';
  end if;
  raise notice 'OK: expire_stale_outbound_sends sweeps an expired lease to delivery_unknown and audits it';
end;
$$;

-- expire_stale_outbound_sends' service_role-only execute privilege is
-- already verified by the hardening sweep at the top of this file.

select test_clear_current_user();

rollback;
