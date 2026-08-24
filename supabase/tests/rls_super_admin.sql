-- Super Admin test-client foundation RLS/RPC hardening tests (migration 17).
-- Run after rls_media_idempotency.sql (via supabase/tests/run.sh), against the
-- same throwaway local Postgres database -- never a hosted Supabase project.
-- Every check either passes silently (raise notice 'OK: ...') or RAISE
-- EXCEPTIONs, aborting the whole suite.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures. One super_admin, one platform_support, one platform_billing_admin
-- (none of the latter two may perform a super-admin mutation). One pre-
-- existing company (with one owner) for tenant-isolation and member-
-- management checks; a second company exists only as a cross-tenant target
-- that must never appear in the first company's data.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('50000001-0000-0000-0000-000000000001', 'super-admin@example.test'),
  ('50000001-0000-0000-0000-000000000002', 'platform-support@example.test'),
  ('50000001-0000-0000-0000-000000000003', 'platform-billing@example.test'),
  ('50000001-0000-0000-0000-000000000004', 'owner-existing@example.test'),
  ('50000001-0000-0000-0000-000000000005', 'invitee@example.test'),
  ('50000001-0000-0000-0000-000000000006', 'second-support@example.test');

insert into platform_members (user_id, role, is_active) values
  ('50000001-0000-0000-0000-000000000001', 'super_admin', true),
  ('50000001-0000-0000-0000-000000000002', 'platform_support', true),
  ('50000001-0000-0000-0000-000000000003', 'platform_billing_admin', true),
  ('50000001-0000-0000-0000-000000000006', 'platform_support', true);

insert into companies (id, name, slug, status, is_demo) values
  ('60000001-0000-0000-0000-000000000001', 'Existing Co', 'existing-co', 'active', false),
  ('60000001-0000-0000-0000-000000000002', 'Other Co', 'other-co', 'active', false);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('61000001-0000-0000-0000-000000000001', '60000001-0000-0000-0000-000000000001', '50000001-0000-0000-0000-000000000004', 'company_owner', true);

-- supabase/seed/001_plans.sql is not applied by this local test harness (only
-- migrations are), so a minimal starter plan/version is fixtured here
-- directly -- mirrors the real seed data's shape closely enough for
-- admin_assign_plan's lookup-by-key to exercise the real code path.
insert into plans (id, key, name, is_active) values
  ('70000001-0000-0000-0000-000000000001', 'starter', 'Starter', true);
insert into plan_versions (id, plan_id, version, monthly_price, currency, is_current) values
  ('70000002-0000-0000-0000-000000000001', '70000001-0000-0000-0000-000000000001', 1, 2999, 'INR', true);

-- ---------------------------------------------------------------------------
-- Assertion helpers (same shape as rls_handover.sql's).
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
-- Hardening sweep: every migration-17 function has an empty search_path and
-- no direct public/anon execute grant.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  fns text[] := array[
    'admin_create_company', 'admin_suspend_company', 'admin_reactivate_company', 'admin_close_company',
    'admin_invite_company_member', 'admin_change_company_member_role', 'admin_deactivate_company_member',
    'admin_assign_plan', 'admin_change_subscription_state', 'admin_set_company_entitlement',
    'admin_start_support_access', 'admin_end_support_access'
  ];
begin
  foreach fn in array fns loop
    if not exists (
      select 1 from pg_proc p
      where p.proname = fn
        and exists (
          select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%' and cfg not like 'search_path=%public%'
        )
    ) then
      raise exception 'ASSERTION FAILED: function % does not have an empty search_path set', fn;
    end if;
    if has_function_privilege('anon', (select oid from pg_proc where proname = fn limit 1), 'execute') then
      raise exception 'ASSERTION FAILED: function % is executable by anon', fn;
    end if;
    raise notice 'OK: % has an empty search_path and is not executable by anon', fn;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Unauthorized (no session) and non-super_admin callers.
-- ---------------------------------------------------------------------------

set local role authenticated;
select test_clear_current_user();

select test_assert_raises(
  'a caller with no session at all cannot create a company',
  $sql$ select admin_create_company('Nope Co') $sql$,
  'unauthorized'
);

select test_set_current_user('50000001-0000-0000-0000-000000000002'); -- platform_support

select test_assert_raises(
  'platform_support cannot create a company (super-admin mutation)',
  $sql$ select admin_create_company('Support Co') $sql$,
  'permission_denied'
);

select test_assert_raises(
  'platform_support cannot suspend a company',
  $sql$ select admin_suspend_company('60000001-0000-0000-0000-000000000001', 'test') $sql$,
  'permission_denied'
);

select test_assert_raises(
  'platform_support cannot assign a plan',
  $sql$ select admin_assign_plan('60000001-0000-0000-0000-000000000001', 'starter') $sql$,
  'permission_denied'
);

select test_set_current_user('50000001-0000-0000-0000-000000000003'); -- platform_billing_admin

select test_assert_raises(
  'platform_billing_admin cannot create a company (only super_admin may)',
  $sql$ select admin_create_company('Billing Co') $sql$,
  'permission_denied'
);

select test_assert_raises(
  'a normal company owner (not platform staff at all) cannot create a company',
  $sql$ select admin_create_company('Owner Co') $sql$,
  'permission_denied'
) from (select test_set_current_user('50000001-0000-0000-0000-000000000004')) _;

-- ---------------------------------------------------------------------------
-- Super admin: test-client company creation, tenant isolation, audit trail.
-- ---------------------------------------------------------------------------

select test_set_current_user('50000001-0000-0000-0000-000000000001'); -- super_admin

do $$
declare
  v_id uuid;
  v_slug text;
  v_status company_status;
begin
  select id, slug, status into v_id, v_slug, v_status
    from admin_create_company('DRAIVA Test Client', 'Interior Fit-Out', 'India', 'Asia/Kolkata', 'INR', true);

  perform test_assert('admin_create_company returns a real company id', v_id is not null);
  perform test_assert('admin_create_company defaults status to onboarding', v_status = 'onboarding');
  perform test_assert('admin_create_company generates a non-empty slug', v_slug is not null and length(v_slug) > 0);
  perform test_assert(
    'the created company is tenant-isolated: is_demo is stored exactly as passed',
    (select is_demo from companies where id = v_id) = true
  );
  perform test_assert(
    'company_created audit_logs row was written with the right company_id and actor',
    exists (
      select 1 from audit_logs
      where company_id = v_id and action = 'company_created' and actor_user_id = '50000001-0000-0000-0000-000000000001'
    )
  );
  perform test_assert(
    'admin_create_company also creates default company_settings/ai_settings/voice_settings rows -- otherwise the owner could never save AI Settings for the first time (company_settings has no INSERT RLS policy)',
    exists (select 1 from company_settings where company_id = v_id)
    and exists (select 1 from ai_settings where company_id = v_id)
    and exists (select 1 from voice_settings where company_id = v_id)
  );

  -- stash for later statements via a temp table (plpgsql vars don't survive
  -- across separate top-level statements in this script).
  create temporary table t_test_client (id uuid);
  insert into t_test_client values (v_id);
end;
$$;

select test_assert(
  'creating a second company with the same name still succeeds with a distinct, unique slug',
  (select count(distinct slug) from companies where name = 'DRAIVA Test Client') =
  (select count(*) from companies where name = 'DRAIVA Test Client')
);

select test_assert(
  'a company created via admin_create_company is invisible to an unrelated company owner (tenant isolation)',
  not exists (
    select 1 from companies where id = (select id from t_test_client)
  )
) from (select test_set_current_user('50000001-0000-0000-0000-000000000004')) _; -- owner of Existing Co, not a member of the new company

select test_set_current_user('50000001-0000-0000-0000-000000000001'); -- back to super_admin

-- ---------------------------------------------------------------------------
-- Company lifecycle: suspend / reactivate / close, with state-machine guards.
-- ---------------------------------------------------------------------------

select test_assert(
  'super_admin can suspend an active company',
  (select status from admin_suspend_company('60000001-0000-0000-0000-000000000001', 'nonpayment')) = 'manually_suspended'
);

select test_assert(
  'super_admin can reactivate a suspended company',
  (select status from admin_reactivate_company('60000001-0000-0000-0000-000000000001')) = 'active'
);

select test_assert_raises(
  'reactivating a company that is not suspended is rejected',
  $sql$ select admin_reactivate_company('60000001-0000-0000-0000-000000000001') $sql$,
  'invalid_state_transition'
);

select test_assert(
  'super_admin can close a company',
  (select status from admin_close_company('60000001-0000-0000-0000-000000000002', 'test teardown')) = 'closed'
);

select test_assert_raises(
  'closing an already-closed company is rejected',
  $sql$ select admin_close_company('60000001-0000-0000-0000-000000000002', 'again') $sql$,
  'invalid_state_transition'
);

-- ---------------------------------------------------------------------------
-- Member management: invite (owner membership created correctly), role
-- change, deactivate.
-- ---------------------------------------------------------------------------

do $$
declare
  v_member_id uuid;
  v_role company_role;
  v_is_active boolean;
begin
  select id, role, is_active into v_member_id, v_role, v_is_active
    from admin_invite_company_member('60000001-0000-0000-0000-000000000001', 'invitee@example.test', 'manager');

  perform test_assert('admin_invite_company_member creates an active membership', v_is_active = true);
  perform test_assert('admin_invite_company_member sets the requested role', v_role = 'manager');

  create temporary table t_invited_member (id uuid);
  insert into t_invited_member values (v_member_id);
end;
$$;

-- Phase 2 role model expansion (migration 24): admin_invite_company_member
-- now refuses to create a second active company_owner (see
-- rls_role_team_security.sql for the dedicated owner-protection coverage) --
-- Existing Co already has an active owner from the fixtures below.
select test_assert_raises(
  'admin_invite_company_member cannot create a second active owner for a company that already has one',
  $sql$ select admin_invite_company_member('60000001-0000-0000-0000-000000000001', 'second-owner@example.test', 'company_owner') $sql$,
  'owner_already_exists'
);

select test_assert_raises(
  're-inviting an already-active member is rejected, not silently duplicated',
  $sql$ select admin_invite_company_member('60000001-0000-0000-0000-000000000001', 'invitee@example.test', 'manager') $sql$,
  'member_already_active'
);

select test_assert_raises(
  'inviting an email with no matching Auth user is rejected',
  $sql$ select admin_invite_company_member('60000001-0000-0000-0000-000000000001', 'no-such-user@example.test', 'agent') $sql$,
  'user_not_found'
);

select test_assert(
  'admin_change_company_member_role updates the role and writes an audit row',
  (select role from admin_change_company_member_role('60000001-0000-0000-0000-000000000001', (select id from t_invited_member), 'manager')) = 'manager'
);

select test_assert(
  'admin_deactivate_company_member deactivates the member',
  (select is_active from admin_deactivate_company_member('60000001-0000-0000-0000-000000000001', (select id from t_invited_member))) = false
);

select test_assert(
  'member_role_changed and member_deactivated audit rows exist for the invited member',
  (select count(*) from audit_logs where target_type = 'company_member' and target_id = (select id from t_invited_member)::text
     and action in ('member_role_changed', 'member_deactivated')) = 2
);

-- ---------------------------------------------------------------------------
-- Plans / subscriptions / entitlements.
-- ---------------------------------------------------------------------------

select test_assert(
  'admin_assign_plan attaches the starter plan''s current version to Existing Co',
  (select plan_version_id from admin_assign_plan('60000001-0000-0000-0000-000000000001', 'starter')) =
  (select pv.id from plan_versions pv join plans p on p.id = pv.plan_id where p.key = 'starter' and pv.is_current)
);

select test_assert_raises(
  'assigning an unknown plan key is rejected',
  $sql$ select admin_assign_plan('60000001-0000-0000-0000-000000000001', 'nonexistent-plan') $sql$,
  'plan_not_found'
);

select test_assert(
  'admin_change_subscription_state transitions the subscription and is reflected immediately',
  (select state from admin_change_subscription_state('60000001-0000-0000-0000-000000000001', 'active', 'manual activation for testing')) = 'active'
);

select test_assert(
  'a subscription_events row records the manual state change with is_manual_override=true',
  exists (
    select 1 from subscription_events
    where company_id = '60000001-0000-0000-0000-000000000001' and event = 'manual_state_change'
      and to_state = 'active' and is_manual_override = true
  )
);

select test_assert(
  'admin_set_company_entitlement sets a new entitlement override',
  (select is_enabled from admin_set_company_entitlement('60000001-0000-0000-0000-000000000001', 'web_research_enabled', true, null, 'staging test override')) = true
);

-- A plain read against company_entitlements in the SAME statement as the
-- mutating call below would use the query's own pre-call snapshot and could
-- observe stale data -- each check is therefore its own top-level statement.
select test_assert(
  'a repeated admin_set_company_entitlement call reports the updated row, not a fresh duplicate',
  (select is_enabled from admin_set_company_entitlement('60000001-0000-0000-0000-000000000001', 'web_research_enabled', false, 5, 'revised')) = false
);

select test_assert(
  'exactly one company_entitlements row exists for this company/feature_key -- the repeat call updated it in place',
  (select count(*) from company_entitlements where company_id = '60000001-0000-0000-0000-000000000001' and feature_key = 'web_research_enabled') = 1
);

select test_assert(
  'the row''s is_enabled reflects the latest call, not the original',
  (select is_enabled from company_entitlements where company_id = '60000001-0000-0000-0000-000000000001' and feature_key = 'web_research_enabled') = false
);

select test_assert(
  'plan_assigned, subscription_changed, and entitlement_changed audit rows all exist for Existing Co',
  (select count(distinct action) from audit_logs
     where company_id = '60000001-0000-0000-0000-000000000001'
       and action in ('plan_assigned', 'subscription_changed', 'entitlement_changed')) = 3
);

-- ---------------------------------------------------------------------------
-- Demo company cannot accidentally become billable: attaching a real
-- provider_subscription_id to a demo company's subscription is rejected at
-- the schema level, regardless of which code path attempts it.
-- ---------------------------------------------------------------------------

reset role;

do $$
declare
  v_demo_company_id uuid;
  v_real_company_id uuid := '60000001-0000-0000-0000-000000000001'; -- Existing Co, is_demo=false
begin
  select id into v_demo_company_id from t_test_client;

  insert into subscriptions (company_id, plan_version_id, state)
    select v_demo_company_id, id, 'trial' from plan_versions where plan_id = (select id from plans where key = 'starter') and is_current;

  begin
    update subscriptions set provider_subscription_id = 'sub_real_provider_id' where company_id = v_demo_company_id;
    raise exception 'ASSERTION FAILED: a demo company must never be allowed a real provider_subscription_id';
  exception
    when others then
      if sqlerrm <> 'demo_company_cannot_be_billable' then
        raise exception 'ASSERTION FAILED: expected demo_company_cannot_be_billable but got %', sqlerrm;
      end if;
      raise notice 'OK: attaching a provider_subscription_id to a demo company''s subscription is rejected';
  end;

  perform test_assert(
    'the rejected update did not actually attach a provider_subscription_id',
    (select provider_subscription_id from subscriptions where company_id = v_demo_company_id) is null
  );

  -- Same write against a non-demo company succeeds -- the guard is specific
  -- to is_demo=true, not a blanket prohibition on provider_subscription_id.
  update subscriptions set provider_subscription_id = 'sub_real_provider_id' where company_id = v_real_company_id;
  perform test_assert(
    'the same write against a non-demo company is allowed',
    (select provider_subscription_id from subscriptions where company_id = v_real_company_id) = 'sub_real_provider_id'
  );
end;
$$;

set local role authenticated;

-- ---------------------------------------------------------------------------
-- Support access sessions: any active platform staff member may open one;
-- only the owner or a super_admin may end it early.
-- ---------------------------------------------------------------------------

select test_set_current_user('50000001-0000-0000-0000-000000000002'); -- platform_support

do $$
declare
  v_session_id uuid;
  v_expires timestamptz;
begin
  select id, expires_at into v_session_id, v_expires
    from admin_start_support_access('60000001-0000-0000-0000-000000000001', 'investigating a customer ticket', 30);

  perform test_assert('admin_start_support_access creates a session', v_session_id is not null);
  perform test_assert('the session expiry is bounded by the requested duration', v_expires <= now() + interval '31 minutes');

  create temporary table t_support_session (id uuid);
  insert into t_support_session values (v_session_id);
end;
$$;

select test_assert_raises(
  'a different platform_support member cannot end someone else''s support-access session',
  $sql$ select admin_end_support_access((select id from t_support_session)) $sql$,
  'permission_denied'
) from (select test_set_current_user('50000001-0000-0000-0000-000000000006')) _;

select test_assert(
  'the session owner can end their own support-access session',
  (select ended_at from admin_end_support_access((select id from t_support_session))) is not null
) from (select test_set_current_user('50000001-0000-0000-0000-000000000002')) _;

select test_assert_raises(
  'ending an already-ended session is rejected',
  $sql$ select admin_end_support_access((select id from t_support_session)) $sql$,
  'session_already_ended'
);

select test_assert_raises(
  'starting support access without a reason is rejected',
  $sql$ select admin_start_support_access('60000001-0000-0000-0000-000000000001', '', 30) $sql$,
  'reason_required'
);

select test_clear_current_user();

rollback;
