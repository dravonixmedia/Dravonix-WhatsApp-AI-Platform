-- Phase 7B Super Admin subscription-lifecycle control plane (migration 32)
-- RLS/RPC hardening tests. Run after rls_billing_automation_corrections.sql
-- (via supabase/tests/run.sh), against the same throwaway local Postgres
-- database -- never a hosted Supabase project. Every check either passes
-- silently (raise notice 'OK: ...') or RAISE EXCEPTIONs, aborting the whole
-- suite.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('80000001-0000-0000-0000-000000000001', 'm32-super-admin@example.test'),
  ('80000001-0000-0000-0000-000000000002', 'm32-platform-support@example.test'),
  ('80000001-0000-0000-0000-000000000003', 'm32-platform-billing@example.test'),
  ('80000001-0000-0000-0000-000000000004', 'm32-company-owner@example.test'),
  ('80000001-0000-0000-0000-000000000005', 'm32-company-admin@example.test'),
  ('80000001-0000-0000-0000-000000000006', 'm32-company-accounts@example.test'),
  ('80000001-0000-0000-0000-000000000007', 'm32-manager@example.test'),
  ('80000001-0000-0000-0000-000000000008', 'm32-team-leader@example.test'),
  ('80000001-0000-0000-0000-000000000009', 'm32-sales-person@example.test');

insert into platform_members (user_id, role, is_active) values
  ('80000001-0000-0000-0000-000000000001', 'super_admin', true),
  ('80000001-0000-0000-0000-000000000002', 'platform_support', true),
  ('80000001-0000-0000-0000-000000000003', 'platform_billing_admin', true);

insert into companies (id, name, slug, status, is_demo) values
  ('81000001-0000-0000-0000-000000000001', 'M32 Co', 'm32-co', 'active', false),
  ('81000001-0000-0000-0000-000000000002', 'M32 Other Co', 'm32-other-co', 'active', false);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('82000001-0000-0000-0000-000000000001', '81000001-0000-0000-0000-000000000001', '80000001-0000-0000-0000-000000000004', 'company_owner', true),
  ('82000001-0000-0000-0000-000000000002', '81000001-0000-0000-0000-000000000001', '80000001-0000-0000-0000-000000000005', 'company_admin', true),
  ('82000001-0000-0000-0000-000000000003', '81000001-0000-0000-0000-000000000001', '80000001-0000-0000-0000-000000000006', 'company_accounts', true),
  ('82000001-0000-0000-0000-000000000004', '81000001-0000-0000-0000-000000000001', '80000001-0000-0000-0000-000000000007', 'manager', true),
  ('82000001-0000-0000-0000-000000000005', '81000001-0000-0000-0000-000000000001', '80000001-0000-0000-0000-000000000008', 'team_leader', true),
  ('82000001-0000-0000-0000-000000000006', '81000001-0000-0000-0000-000000000001', '80000001-0000-0000-0000-000000000009', 'sales_person', true);

insert into plans (id, key, name, is_active) values
  ('83000001-0000-0000-0000-000000000001', 'm32-starter', 'M32 Starter', true);
insert into plan_versions (id, plan_id, version, monthly_price, currency, grace_period_days, is_current) values
  ('83000002-0000-0000-0000-000000000001', '83000001-0000-0000-0000-000000000001', 1, 999, 'INR', 5, true);

insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end)
  values ('84000001-0000-0000-0000-000000000001', '81000001-0000-0000-0000-000000000001', '83000002-0000-0000-0000-000000000001', 'onboarding', now() - interval '10 days', now() + interval '20 days');

insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end)
  values ('84000001-0000-0000-0000-000000000002', '81000001-0000-0000-0000-000000000002', '83000002-0000-0000-0000-000000000001', 'active', now() - interval '10 days', now() + interval '20 days');

-- ---------------------------------------------------------------------------
-- Assertion helpers (same shape as rls_super_admin.sql's).
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
-- Authorization sweep: admin_change_subscription_state.
-- ---------------------------------------------------------------------------

set local role authenticated;
select test_clear_current_user();

select test_assert_raises(
  'unauthenticated: admin_change_subscription_state denied',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'unauthorized'
);

select test_assert_raises(
  'company_owner: admin_change_subscription_state denied',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000004')) _;

select test_assert_raises(
  'company_admin: admin_change_subscription_state denied',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000005')) _;

select test_assert_raises(
  'company_accounts: admin_change_subscription_state denied',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000006')) _;

select test_assert_raises(
  'manager: admin_change_subscription_state denied',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000007')) _;

select test_assert_raises(
  'team_leader: admin_change_subscription_state denied',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000008')) _;

select test_assert_raises(
  'sales_person: admin_change_subscription_state denied',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000009')) _;

select test_assert_raises(
  'platform_support: admin_change_subscription_state denied (not super_admin)',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000002')) _;

select test_assert_raises(
  'platform_billing_admin: admin_change_subscription_state denied (not super_admin)',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000003')) _;

-- ---------------------------------------------------------------------------
-- Authorization sweep: admin_reset_company_entitlement (same shape).
-- ---------------------------------------------------------------------------

select test_clear_current_user();
select test_assert_raises(
  'unauthenticated: admin_reset_company_entitlement denied',
  $sql$ select admin_reset_company_entitlement('81000001-0000-0000-0000-000000000001', 'voice_enabled', null) $sql$,
  'unauthorized'
);

select test_assert_raises(
  'company_owner: admin_reset_company_entitlement denied',
  $sql$ select admin_reset_company_entitlement('81000001-0000-0000-0000-000000000001', 'voice_enabled', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000004')) _;

select test_assert_raises(
  'platform_support: admin_reset_company_entitlement denied',
  $sql$ select admin_reset_company_entitlement('81000001-0000-0000-0000-000000000001', 'voice_enabled', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000002')) _;

select test_assert_raises(
  'platform_billing_admin: admin_reset_company_entitlement denied',
  $sql$ select admin_reset_company_entitlement('81000001-0000-0000-0000-000000000001', 'voice_enabled', null) $sql$,
  'permission_denied'
) from (select test_set_current_user('80000001-0000-0000-0000-000000000003')) _;

-- ---------------------------------------------------------------------------
-- Grant sweep: finalize_scheduled_subscription_cancellations is service_role
-- only -- no internal exception fires for a non-service_role caller; the
-- grant itself must simply not exist for authenticated/anon.
-- ---------------------------------------------------------------------------

select test_set_current_user('80000001-0000-0000-0000-000000000001'); -- super_admin

select test_assert(
  'finalize_scheduled_subscription_cancellations is not executable by authenticated (super_admin included)',
  not has_function_privilege('authenticated', 'finalize_scheduled_subscription_cancellations()', 'execute')
);

select test_assert(
  'finalize_scheduled_subscription_cancellations is not executable by anon',
  not has_function_privilege('anon', 'finalize_scheduled_subscription_cancellations()', 'execute')
);

select test_assert(
  'finalize_scheduled_subscription_cancellations IS executable by service_role',
  has_function_privilege('service_role', 'finalize_scheduled_subscription_cancellations()', 'execute')
);

-- ---------------------------------------------------------------------------
-- search_path/grant hardening sweep for all three migration-32 functions.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  fns text[] := array[
    'admin_change_subscription_state', 'admin_reset_company_entitlement',
    'finalize_scheduled_subscription_cancellations'
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
-- Admin-allowed transition matrix. One subscription row is directly reset
-- to each starting state via a superuser-level update (bypassing RLS, which
-- is fine here -- fixture setup, not the thing under test), then the RPC is
-- called as super_admin and the outcome is asserted.
-- ---------------------------------------------------------------------------

set local role postgres;
create or replace function m32_reset_sub(p_state subscription_state, p_grace timestamptz default null, p_susp text default null, p_cancel text default null, p_reactivated timestamptz default null) returns void
  language sql
  security definer
  set search_path = ''
  as $$
  update public.subscriptions set
    state = p_state,
    grace_period_end = p_grace,
    suspension_reason = p_susp,
    cancellation_reason = p_cancel,
    reactivated_at = p_reactivated
  where id = '84000001-0000-0000-0000-000000000001';
$$;
set local role authenticated;
select test_set_current_user('80000001-0000-0000-0000-000000000001'); -- super_admin

-- onboarding -> trial (start_trial)
select m32_reset_sub('onboarding');
select test_assert(
  'onboarding -> trial succeeds via start_trial',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null)) = 'trial'
);
select test_assert(
  'onboarding -> trial writes the canonical start_trial event',
  exists (select 1 from subscription_events where subscription_id = '84000001-0000-0000-0000-000000000001' and event = 'start_trial' and from_state = 'onboarding' and to_state = 'trial' and is_manual_override = true)
);

-- onboarding -> active is REJECTED (post-independent-review correction):
-- admin_assign_plan never establishes current_period_start/current_period_end,
-- so force-activating from onboarding would produce an `active` subscription
-- generate_due_subscription_invoices can never bill (its eligibility requires
-- current_period_end is not null).
select m32_reset_sub('onboarding');
select test_assert_raises(
  'onboarding -> active is rejected (would create an unbillable active subscription with no billing-period dates)',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'active', null) $sql$,
  'invalid_state_transition'
);

-- onboarding -> closed (close)
select m32_reset_sub('onboarding');
select test_assert(
  'onboarding -> closed succeeds via close',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'closed', null)) = 'closed'
);

-- trial -> active is REJECTED (post-independent-review correction): same
-- unbillable-active-subscription reasoning as onboarding -> active above --
-- a trial subscription may never have had a real payment establish
-- current_period_start/current_period_end either.
select m32_reset_sub('trial');
select test_assert_raises(
  'trial -> active is rejected (would create an unbillable active subscription with no billing-period dates)',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'active', null) $sql$,
  'invalid_state_transition'
);

-- trial -> cancelled (cancelled_immediately), reason required at the app
-- layer only -- the RPC itself accepts a null reason too.
select m32_reset_sub('trial');
select test_assert(
  'trial -> cancelled succeeds via cancelled_immediately',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancelled', 'test reason')) = 'cancelled'
);
select test_assert(
  'trial -> cancelled sets cancellation_reason from p_reason',
  (select cancellation_reason from subscriptions where id = '84000001-0000-0000-0000-000000000001') = 'test reason'
);
select test_assert(
  'trial -> cancelled writes audit action subscription_cancelled',
  exists (select 1 from audit_logs where target_id = '84000001-0000-0000-0000-000000000001' and action = 'subscription_cancelled' and metadata->>'event' = 'cancelled_immediately')
);

-- active -> cancel_at_period_end (schedule cancellation)
select m32_reset_sub('active');
do $$
declare
  v_period_end_before timestamptz;
begin
  select current_period_end into v_period_end_before from subscriptions where id = '84000001-0000-0000-0000-000000000001';
  perform test_assert(
    'active -> cancel_at_period_end succeeds via cancel_at_period_end_requested',
    (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancel_at_period_end', 'pausing')) = 'cancel_at_period_end'
  );
  perform test_assert(
    'schedule cancellation sets cancellation_reason and preserves current_period_end exactly',
    (select cancellation_reason from subscriptions where id = '84000001-0000-0000-0000-000000000001') = 'pausing'
    and (select current_period_end from subscriptions where id = '84000001-0000-0000-0000-000000000001') = v_period_end_before
  );
end;
$$;
select test_assert(
  'schedule cancellation writes audit action subscription_cancel_scheduled',
  exists (select 1 from audit_logs where target_id = '84000001-0000-0000-0000-000000000001' and action = 'subscription_cancel_scheduled')
);

-- cancel_at_period_end -> active (reverse), from the state set above
select test_assert(
  'cancel_at_period_end -> active succeeds via cancel_at_period_end_reversed',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'active', null)) = 'active'
);
select test_assert(
  'reversing cancellation clears cancellation_reason',
  (select cancellation_reason from subscriptions where id = '84000001-0000-0000-0000-000000000001') is null
);
select test_assert(
  'reversing cancellation writes audit action subscription_cancel_reversed',
  exists (select 1 from audit_logs where target_id = '84000001-0000-0000-0000-000000000001' and action = 'subscription_cancel_reversed')
);

-- active -> cancelled (immediate)
select m32_reset_sub('active');
select test_assert(
  'active -> cancelled succeeds via cancelled_immediately',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancelled', 'fraud')) = 'cancelled'
);

-- cancelled -> active (win-back) is REJECTED (post-independent-review
-- correction): flipping the state alone leaves current_period_start/end
-- stale, which the billing scheduler would likely reinterpret as an
-- immediately lapsed period. Win-back needs its own future architecture
-- (new billing period, invoice/payment requirements, entitlement timing);
-- Phase 7B does not define one, so the admin RPC must not attempt it.
select test_assert_raises(
  'cancelled -> active is rejected (win-back semantics are undefined -- no billing-period refresh)',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'active', null) $sql$,
  'invalid_state_transition'
);

-- active -> manually_suspended (manual suspend)
select m32_reset_sub('active');
select test_assert(
  'active -> manually_suspended succeeds via manual_suspend',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'manually_suspended', 'nonpayment via bank')) = 'manually_suspended'
);
select test_assert(
  'manual suspend sets suspension_reason from p_reason',
  (select suspension_reason from subscriptions where id = '84000001-0000-0000-0000-000000000001') = 'nonpayment via bank'
);
select test_assert(
  'manual suspend writes audit action subscription_manually_suspended',
  exists (select 1 from audit_logs where target_id = '84000001-0000-0000-0000-000000000001' and action = 'subscription_manually_suspended')
);

-- manually_suspended -> active (reactivate)
select m32_reset_sub('manually_suspended', null, 'nonpayment via bank');
select test_assert(
  'manually_suspended -> active succeeds via manual_reactivate',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'active', null)) = 'active'
);
select test_assert(
  'reactivation clears suspension_reason and sets reactivated_at',
  (select suspension_reason from subscriptions where id = '84000001-0000-0000-0000-000000000001') is null
  and (select reactivated_at from subscriptions where id = '84000001-0000-0000-0000-000000000001') is not null
);
select test_assert(
  'reactivation writes audit action subscription_reactivated',
  exists (select 1 from audit_logs where target_id = '84000001-0000-0000-0000-000000000001' and action = 'subscription_reactivated')
);

-- manually_suspended -> cancelled
select m32_reset_sub('manually_suspended');
select test_assert(
  'manually_suspended -> cancelled succeeds via cancelled_immediately',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancelled', 'closing account')) = 'cancelled'
);

-- payment_due -> active is REJECTED (post-independent-review correction):
-- the admin RPC must never be able to fabricate the canonical
-- payment_recovered event. Real payment recovery remains exclusively owned
-- by reconcile_razorpay_payment (migrations 28/29, verified unchanged by
-- the "real payment recovery regression" tests below).
select m32_reset_sub('payment_due', now() + interval '5 days');
select test_assert_raises(
  'payment_due -> active is rejected (admin RPC must never fabricate payment_recovered)',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'active', 'manual bank transfer confirmed') $sql$,
  'invalid_state_transition'
);
select test_assert(
  'a rejected payment_due -> active attempt leaves grace_period_end untouched -- no partial write',
  (select grace_period_end from subscriptions where id = '84000001-0000-0000-0000-000000000001') is not null
);
select test_assert(
  'a rejected payment_due -> active attempt leaves state at payment_due -- no partial write',
  (select state from subscriptions where id = '84000001-0000-0000-0000-000000000001') = 'payment_due'
);

-- payment_due -> manually_suspended / cancelled / closed
select m32_reset_sub('payment_due');
select test_assert(
  'payment_due -> manually_suspended succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'manually_suspended', 'req')) = 'manually_suspended'
);
select m32_reset_sub('payment_due');
select test_assert(
  'payment_due -> cancelled succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancelled', 'req')) = 'cancelled'
);
select m32_reset_sub('payment_due');
select test_assert(
  'payment_due -> closed succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'closed', null)) = 'closed'
);

-- grace_period -> active is REJECTED (post-independent-review correction),
-- same reasoning as payment_due -> active above -- manually_suspended /
-- cancelled / closed remain admin-allowed.
select m32_reset_sub('grace_period', now() + interval '3 days');
select test_assert_raises(
  'grace_period -> active is rejected (admin RPC must never fabricate payment_recovered)',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'active', null) $sql$,
  'invalid_state_transition'
);
select test_assert(
  'a rejected grace_period -> active attempt leaves grace_period_end untouched -- no partial write',
  (select grace_period_end from subscriptions where id = '84000001-0000-0000-0000-000000000001') is not null
);
select m32_reset_sub('grace_period');
select test_assert(
  'grace_period -> manually_suspended succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'manually_suspended', 'req')) = 'manually_suspended'
);
select m32_reset_sub('grace_period');
select test_assert(
  'grace_period -> cancelled succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancelled', 'req')) = 'cancelled'
);
select m32_reset_sub('grace_period');
select test_assert(
  'grace_period -> closed succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'closed', null)) = 'closed'
);

-- suspended -> active / cancelled / closed
select m32_reset_sub('suspended');
select test_assert(
  'suspended -> active succeeds via manual_reactivate',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'active', null)) = 'active'
);
select m32_reset_sub('suspended');
select test_assert(
  'suspended -> cancelled succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancelled', 'req')) = 'cancelled'
);
select m32_reset_sub('suspended');
select test_assert(
  'suspended -> closed succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'closed', null)) = 'closed'
);

-- cancel_at_period_end -> closed, cancelled -> closed
select m32_reset_sub('cancel_at_period_end');
select test_assert(
  'cancel_at_period_end -> closed succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'closed', null)) = 'closed'
);
select m32_reset_sub('cancelled');
select test_assert(
  'cancelled -> closed succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'closed', null)) = 'closed'
);

-- Billing period dates are never touched by any of the above transitions.
select m32_reset_sub('active');
do $$
declare
  v_before_start timestamptz;
  v_before_end timestamptz;
begin
  select current_period_start, current_period_end into v_before_start, v_before_end
    from subscriptions where id = '84000001-0000-0000-0000-000000000001';
  perform admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'manually_suspended', 'req');
  perform test_assert(
    'admin_change_subscription_state never touches current_period_start/current_period_end',
    (select current_period_start from subscriptions where id = '84000001-0000-0000-0000-000000000001') = v_before_start
    and (select current_period_end from subscriptions where id = '84000001-0000-0000-0000-000000000001') = v_before_end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Forbidden and automatic-only transitions -- every one rejected with the
-- same invalid_state_transition exception, never silently accepted.
-- ---------------------------------------------------------------------------

select m32_reset_sub('closed');
select test_assert_raises(
  'closed -> trial is forbidden (terminal state, no exceptions)',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'invalid_state_transition'
);
select test_assert_raises(
  'closed -> active is forbidden',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'active', null) $sql$,
  'invalid_state_transition'
);

select m32_reset_sub('suspended');
select test_assert_raises(
  'suspended -> trial is forbidden',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'invalid_state_transition'
);

select m32_reset_sub('active');
select test_assert_raises(
  'active -> onboarding is forbidden',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'onboarding', null) $sql$,
  'invalid_state_transition'
);

select m32_reset_sub('grace_period');
select test_assert_raises(
  'grace_period -> trial is forbidden',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'trial', null) $sql$,
  'invalid_state_transition'
);

select m32_reset_sub('trial');
select test_assert_raises(
  'trial -> payment_due is automatic-only (scheduler-owned), rejected via admin RPC',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'payment_due', null) $sql$,
  'invalid_state_transition'
);

select m32_reset_sub('active');
select test_assert_raises(
  'active -> payment_due is automatic-only, rejected via admin RPC',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'payment_due', null) $sql$,
  'invalid_state_transition'
);

select m32_reset_sub('payment_due');
select test_assert_raises(
  'payment_due -> grace_period is automatic-only, rejected via admin RPC',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'grace_period', null) $sql$,
  'invalid_state_transition'
);

select m32_reset_sub('grace_period');
select test_assert_raises(
  'grace_period -> suspended is automatic-only, rejected via admin RPC',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'suspended', null) $sql$,
  'invalid_state_transition'
);

select m32_reset_sub('cancel_at_period_end');
select test_assert_raises(
  'cancel_at_period_end -> cancelled is automatic-only (finalize_scheduled_subscription_cancellations'' job), rejected via admin RPC',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancelled', null) $sql$,
  'invalid_state_transition'
);

select test_assert_raises(
  'a same-state no-op is rejected (never a valid admin transition)',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancel_at_period_end', null) $sql$,
  'invalid_state_transition'
);

-- ---------------------------------------------------------------------------
-- Simulated race: an admin transition valid for a stale state must be
-- re-validated against the row's REAL current state (the FOR UPDATE lock's
-- own fresh read), never a value the caller assumed. Simulates "the
-- scheduler moved this subscription before the admin's request landed."
-- ---------------------------------------------------------------------------

-- Simulate the scheduler winning the race: active -> payment_due, exactly
-- as advance_overdue_subscriptions would (bypassing the admin RPC here,
-- since only service_role can call that one -- the point under test is
-- admin_change_subscription_state's own re-read, not the scheduler RPC).
-- m32_reset_sub is used here purely as a SECURITY DEFINER row-write helper
-- (it bypasses RLS the same way service_role would), not because this is a
-- "reset to a starting state" in the matrix-test sense above.
select m32_reset_sub('payment_due');
select test_assert_raises(
  'an admin transition valid for the OLD (pre-race) state is rejected once the row has actually moved -- active -> cancel_at_period_end no longer applies once the row is really payment_due',
  $sql$ select admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'cancel_at_period_end', null) $sql$,
  'invalid_state_transition'
);
select test_assert(
  'the same request re-issued against the REAL current state (payment_due -> manually_suspended) succeeds',
  (select state from admin_change_subscription_state('81000001-0000-0000-0000-000000000001', 'manually_suspended', 'race test')) = 'manually_suspended'
);

-- ---------------------------------------------------------------------------
-- finalize_scheduled_subscription_cancellations (service_role only).
-- ---------------------------------------------------------------------------

set local role postgres; -- service_role has no login role in this local harness; postgres exercises the same SECURITY DEFINER body
select m32_reset_sub('active'); -- unrelated subscription, must stay untouched by the scheduler below

do $$
declare
  v_future_id uuid := '85000001-0000-0000-0000-000000000001';
  v_past_id uuid := '85000001-0000-0000-0000-000000000002';
  v_other_company_past_id uuid := '85000001-0000-0000-0000-000000000003';
begin
  insert into companies (id, name, slug, status, is_demo) values
    ('81000001-0000-0000-0000-000000000003', 'M32 Future Cancel Co', 'm32-future-cancel-co', 'active', false),
    ('81000001-0000-0000-0000-000000000004', 'M32 Past Cancel Co', 'm32-past-cancel-co', 'active', false),
    ('81000001-0000-0000-0000-000000000005', 'M32 Other Past Cancel Co', 'm32-other-past-cancel-co', 'active', false);

  insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end, cancellation_reason)
    values
      (v_future_id, '81000001-0000-0000-0000-000000000003', '83000002-0000-0000-0000-000000000001', 'cancel_at_period_end', now() - interval '10 days', now() + interval '10 days', 'scheduled, not due yet'),
      (v_past_id, '81000001-0000-0000-0000-000000000004', '83000002-0000-0000-0000-000000000001', 'cancel_at_period_end', now() - interval '40 days', now() - interval '1 day', 'scheduled, period ended'),
      (v_other_company_past_id, '81000001-0000-0000-0000-000000000005', '83000002-0000-0000-0000-000000000001', 'cancel_at_period_end', now() - interval '40 days', now() - interval '2 days', 'also ended, different company');

  perform finalize_scheduled_subscription_cancellations();

  perform test_assert(
    'cancel_at_period_end before period end: unchanged',
    (select state from subscriptions where id = v_future_id) = 'cancel_at_period_end'
  );
  perform test_assert(
    'cancel_at_period_end after period end: finalized to cancelled',
    (select state from subscriptions where id = v_past_id) = 'cancelled'
  );
  perform test_assert(
    'the correct canonical event period_ended_after_cancellation is written',
    exists (select 1 from subscription_events where subscription_id = v_past_id and event = 'period_ended_after_cancellation' and from_state = 'cancel_at_period_end' and to_state = 'cancelled' and is_manual_override = false)
  );
  perform test_assert(
    'the automated finalize is audited as a system action (actor_user_id null)',
    exists (select 1 from audit_logs where target_id = v_past_id::text and action = 'subscription_cancelled' and actor_type = 'system' and actor_user_id is null)
  );
  perform test_assert(
    'a second, independent company past its period is also finalized -- company isolation, not a single-row fluke',
    (select state from subscriptions where id = v_other_company_past_id) = 'cancelled'
  );
  perform test_assert(
    'the unrelated active subscription is completely untouched by the scheduler run',
    (select state from subscriptions where id = '84000001-0000-0000-0000-000000000001') = 'active'
  );

  -- Rerun: idempotent, no duplicate event.
  perform finalize_scheduled_subscription_cancellations();
  perform test_assert(
    'rerunning finalize_scheduled_subscription_cancellations does not duplicate the event for an already-finalized subscription',
    (select count(*) from subscription_events where subscription_id = v_past_id and event = 'period_ended_after_cancellation') = 1
  );
end;
$$;
set local role authenticated;

-- ---------------------------------------------------------------------------
-- admin_reset_company_entitlement.
-- ---------------------------------------------------------------------------

select test_set_current_user('80000001-0000-0000-0000-000000000001'); -- super_admin

select admin_set_company_entitlement('81000001-0000-0000-0000-000000000001', 'voice_enabled', true, null, 'granting voice');
select test_assert(
  'fixture: company override for voice_enabled exists before reset',
  exists (select 1 from company_entitlements where company_id = '81000001-0000-0000-0000-000000000001' and feature_key = 'voice_enabled')
);

select admin_set_company_entitlement('81000001-0000-0000-0000-000000000002', 'voice_enabled', true, null, 'other company grant');

do $$
declare
  v_had_override boolean;
begin
  select had_override into v_had_override
    from admin_reset_company_entitlement('81000001-0000-0000-0000-000000000001', 'voice_enabled', 'no longer needed');
  perform test_assert('admin_reset_company_entitlement reports had_override=true when a row existed', v_had_override = true);
end;
$$;

select test_assert(
  'resetting deletes exactly the target company override row',
  not exists (select 1 from company_entitlements where company_id = '81000001-0000-0000-0000-000000000001' and feature_key = 'voice_enabled')
);

select test_assert(
  'company isolation: company A''s reset never touches company B''s override for the same feature_key',
  exists (select 1 from company_entitlements where company_id = '81000001-0000-0000-0000-000000000002' and feature_key = 'voice_enabled')
);

select test_assert(
  'a reset audit row was written with the correct company/action/metadata',
  exists (
    select 1 from audit_logs
    where company_id = '81000001-0000-0000-0000-000000000001' and actor_user_id = '80000001-0000-0000-0000-000000000001'
      and action = 'entitlement_reset' and metadata->>'feature_key' = 'voice_enabled' and metadata->>'reason' = 'no longer needed'
  )
);

do $$
declare
  v_had_override boolean;
begin
  select had_override into v_had_override
    from admin_reset_company_entitlement('81000001-0000-0000-0000-000000000001', 'nonexistent_feature', null);
  perform test_assert('resetting a nonexistent override is a safe no-op reporting had_override=false', v_had_override = false);
end;
$$;

select test_assert(
  'the no-op reset still writes an audit row (attempted action stays observable)',
  exists (select 1 from audit_logs where company_id = '81000001-0000-0000-0000-000000000001' and action = 'entitlement_reset' and metadata->>'feature_key' = 'nonexistent_feature' and metadata->>'had_override' = 'false')
);

do $$
begin
  perform admin_reset_company_entitlement('81000001-0000-0000-0000-000000000001', 'voice_enabled', null);
  perform admin_reset_company_entitlement('81000001-0000-0000-0000-000000000001', 'voice_enabled', null);
  perform test_assert(
    'resetting the same already-absent override twice in a row is safe',
    not exists (select 1 from company_entitlements where company_id = '81000001-0000-0000-0000-000000000001' and feature_key = 'voice_enabled')
  );
end;
$$;

select test_assert(
  'plan_entitlements is never touched by admin_reset_company_entitlement',
  not exists (select 1 from plan_entitlements where plan_version_id = '83000002-0000-0000-0000-000000000001' and feature_key in ('voice_enabled', 'nonexistent_feature'))
);

select test_clear_current_user();

rollback;
