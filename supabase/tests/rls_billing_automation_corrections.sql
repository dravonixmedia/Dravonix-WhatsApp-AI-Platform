-- Phase 6C: Migration 31 billing automation corrections. Run after
-- rls_billing_automation.sql (via supabase/tests/run.sh), against the same
-- throwaway local Postgres database -- never a hosted Supabase project.
--
-- Covers exactly the three Migration 31 corrections:
--   1. advance_overdue_subscriptions' company-local (not UTC) paid-cycle
--      comparison.
--   2. send_due_billing_reminders' subscription-state lifecycle filter.
--   3. billing_invoice_number_seq's anon/authenticated privilege revocation.
--
-- rls_billing_automation.sql already covers every other Migration 30
-- behavior (invoice generation/idempotency, grace-period arithmetic,
-- suspension, payment recovery, admin overview gating, cross-tenant
-- isolation) unaffected by these corrections -- this file does not repeat
-- that coverage.

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

-- ---------------------------------------------------------------------------
-- Shared fixtures: one plan_version (grace_period_days = 4, reused from
-- rls_billing_automation.sql's own convention).
-- ---------------------------------------------------------------------------

insert into plans (id, key, name, is_active) values
  ('26600001-0000-0000-0000-000000000001', 'billauto-m31-plan', 'BillAuto M31 Plan', true);
insert into plan_versions (id, plan_id, version, monthly_price, currency, is_current, grace_period_days) values
  ('26700001-0000-0000-0000-000000000001', '26600001-0000-0000-0000-000000000001', 1, 999.00, 'INR', true, 4);

insert into auth.users (id, email) values
  ('e6100001-0000-0000-0000-000000000001', 'owner-m31@example.test');

-- ===========================================================================
-- SECTION A -- advance_overdue_subscriptions timezone correction
-- ===========================================================================
--
-- Companies:
--   TZU (UTC, lapsed, already paid)        -- must NOT advance (UTC regression)
--   TZK-P (Asia/Kolkata, lapsed, paid using LOCAL date -- the exact migration
--          30 bug scenario)                -- must NOT advance
--   TZK-U (Asia/Kolkata, lapsed, unpaid)    -- must still advance (unpaid control)
--   TZN-P (America/New_York, lapsed, paid using LOCAL date) -- must NOT advance
--   TZN-U (America/New_York, lapsed, unpaid) -- must still advance
--   TZK-X (Asia/Kolkata, lapsed, unpaid -- second company sharing the exact
--          same billing_period_end date as TZK-P's paid invoice, to prove a
--          cross-company invoice can never satisfy another company's
--          paid-cycle check)
-- ===========================================================================

do $$
declare
  v_period_end_utc timestamptz := date_trunc('day', now()) - interval '3 days' + interval '12 hours';
  v_period_end_kolkata timestamptz := date_trunc('day', now()) - interval '3 days' + interval '22 hours 30 minutes';
  v_period_end_ny timestamptz := date_trunc('day', now()) - interval '3 days' + interval '2 hours';
  v_local_date_utc date;
  v_local_date_kolkata date;
  v_local_date_ny date;
  v_utc_date_kolkata date;
  v_utc_date_ny date;
begin
  v_local_date_utc := (v_period_end_utc at time zone 'UTC')::date;
  v_local_date_kolkata := (v_period_end_kolkata at time zone 'Asia/Kolkata')::date;
  v_local_date_ny := (v_period_end_ny at time zone 'America/New_York')::date;
  v_utc_date_kolkata := (v_period_end_kolkata at time zone 'UTC')::date;
  v_utc_date_ny := (v_period_end_ny at time zone 'UTC')::date;

  -- Sanity: these fixtures actually straddle the UTC/local calendar-date
  -- boundary (otherwise the test would not exercise the bug at all).
  perform test_assert('fixture sanity: Kolkata local date differs from its UTC date',
    v_local_date_kolkata <> v_utc_date_kolkata);
  perform test_assert('fixture sanity: New York local date differs from its UTC date',
    v_local_date_ny <> v_utc_date_ny);

  insert into companies (id, name, slug, status, is_demo, timezone) values
    ('c6100001-0000-0000-0000-000000000001', 'M31 TZU (UTC, lapsed, paid)', 'm31-tzu', 'active', true, 'UTC'),
    ('c6100002-0000-0000-0000-000000000001', 'M31 TZK-P (Kolkata, lapsed, paid local-date)', 'm31-tzk-p', 'active', true, 'Asia/Kolkata'),
    ('c6100003-0000-0000-0000-000000000001', 'M31 TZK-U (Kolkata, lapsed, unpaid)', 'm31-tzk-u', 'active', true, 'Asia/Kolkata'),
    ('c6100004-0000-0000-0000-000000000001', 'M31 TZN-P (New York, lapsed, paid local-date)', 'm31-tzn-p', 'active', true, 'America/New_York'),
    ('c6100005-0000-0000-0000-000000000001', 'M31 TZN-U (New York, lapsed, unpaid)', 'm31-tzn-u', 'active', true, 'America/New_York'),
    ('c6100006-0000-0000-0000-000000000001', 'M31 TZK-X (Kolkata, lapsed, unpaid, shares TZK-P''s cycle date)', 'm31-tzk-x', 'active', true, 'Asia/Kolkata');

  insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end) values
    ('26800001-0000-0000-0000-000000000001', 'c6100001-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'active', v_period_end_utc - interval '30 days', v_period_end_utc),
    ('26800002-0000-0000-0000-000000000001', 'c6100002-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'active', v_period_end_kolkata - interval '30 days', v_period_end_kolkata),
    ('26800003-0000-0000-0000-000000000001', 'c6100003-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'active', v_period_end_kolkata - interval '30 days', v_period_end_kolkata),
    ('26800004-0000-0000-0000-000000000001', 'c6100004-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'active', v_period_end_ny - interval '30 days', v_period_end_ny),
    ('26800005-0000-0000-0000-000000000001', 'c6100005-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'active', v_period_end_ny - interval '30 days', v_period_end_ny),
    ('26800006-0000-0000-0000-000000000001', 'c6100006-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'active', v_period_end_kolkata - interval '30 days', v_period_end_kolkata);

  -- TZU: paid, using the UTC-and-local-agreeing date (regression control).
  insert into invoices (company_id, kind, invoice_number, status, currency, subtotal, tax, discount, total, due_date, billing_period_start, billing_period_end, paid_date)
    values ('c6100001-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000001', 'paid', 'INR', 999,0,0,999, v_local_date_utc, v_local_date_utc - 30, v_local_date_utc, v_local_date_utc);

  -- TZK-P: paid, using the company-LOCAL Kolkata date (exactly how
  -- generate_due_subscription_invoices records it) -- migration 30's bug
  -- compared this against the UTC date instead and would have missed it.
  insert into invoices (company_id, kind, invoice_number, status, currency, subtotal, tax, discount, total, due_date, billing_period_start, billing_period_end, paid_date)
    values ('c6100002-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000002', 'paid', 'INR', 999,0,0,999, v_local_date_kolkata, v_local_date_kolkata - 30, v_local_date_kolkata, v_local_date_kolkata);

  -- TZN-P: paid, using the company-LOCAL New York date.
  insert into invoices (company_id, kind, invoice_number, status, currency, subtotal, tax, discount, total, due_date, billing_period_start, billing_period_end, paid_date)
    values ('c6100004-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000003', 'paid', 'INR', 999,0,0,999, v_local_date_ny, v_local_date_ny - 30, v_local_date_ny, v_local_date_ny);

  -- TZK-X: a DIFFERENT company's paid invoice that happens to share the
  -- exact same billing_period_end date as TZK-P's -- must never satisfy
  -- TZK-X's own (unpaid) paid-cycle check.
  insert into invoices (company_id, kind, invoice_number, status, currency, subtotal, tax, discount, total, due_date, billing_period_start, billing_period_end)
    values ('c6100006-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000004', 'pending', 'INR', 999,0,0,999, v_local_date_kolkata, v_local_date_kolkata - 30, v_local_date_kolkata);
end;
$$;

set local role service_role;

do $$
declare v_advanced jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_advanced from advance_overdue_subscriptions() g;

  perform test_assert('advance_overdue_subscriptions advances exactly TZK-U, TZN-U, and TZK-X (the three genuinely-unpaid lapsed subscriptions)',
    (select count(*) from jsonb_array_elements(v_advanced) e where e->>'company_id' = 'c6100003-0000-0000-0000-000000000001') = 1
    and (select count(*) from jsonb_array_elements(v_advanced) e where e->>'company_id' = 'c6100005-0000-0000-0000-000000000001') = 1
    and (select count(*) from jsonb_array_elements(v_advanced) e where e->>'company_id' = 'c6100006-0000-0000-0000-000000000001') = 1
    and jsonb_array_length(v_advanced) = 3);

  perform test_assert('TZU (UTC, already paid) is correctly left active -- UTC-company regression unaffected by the fix',
    (select state from subscriptions where company_id = 'c6100001-0000-0000-0000-000000000001') = 'active');

  perform test_assert('TZK-P (Asia/Kolkata, already paid using the local date) is correctly recognized as paid and left active -- THE FIX',
    (select state from subscriptions where company_id = 'c6100002-0000-0000-0000-000000000001') = 'active');
  perform test_assert('TZK-P has no subscription_events at all (never advanced)',
    not exists (select 1 from subscription_events where subscription_id = '26800002-0000-0000-0000-000000000001'));

  perform test_assert('TZN-P (America/New_York, already paid using the local date) is correctly recognized as paid and left active -- THE FIX',
    (select state from subscriptions where company_id = 'c6100004-0000-0000-0000-000000000001') = 'active');
  perform test_assert('TZN-P has no subscription_events at all (never advanced)',
    not exists (select 1 from subscription_events where subscription_id = '26800004-0000-0000-0000-000000000001'));

  perform test_assert('TZK-U (Asia/Kolkata, genuinely unpaid) still correctly advances into grace_period -- unpaid control',
    (select state from subscriptions where company_id = 'c6100003-0000-0000-0000-000000000001') = 'grace_period');
  perform test_assert('TZN-U (America/New_York, genuinely unpaid) still correctly advances into grace_period -- unpaid control',
    (select state from subscriptions where company_id = 'c6100005-0000-0000-0000-000000000001') = 'grace_period');

  perform test_assert('TZK-X (a different company sharing TZK-P''s exact cycle date) still advances -- TZK-P''s paid invoice can never satisfy TZK-X''s own paid-cycle check (cross-company isolation)',
    (select state from subscriptions where company_id = 'c6100006-0000-0000-0000-000000000001') = 'grace_period');

  raise notice 'OK: advance_overdue_subscriptions now compares company-local calendar dates on both sides, correctly recognizing an already-paid non-UTC cycle while still advancing genuinely-unpaid subscriptions, with no cross-company leakage';
end;
$$;

-- Rerun: no duplicate transitions for the three subscriptions that advanced.
do $$
declare v_advanced jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_advanced from advance_overdue_subscriptions() g;
  perform test_assert('a second advance_overdue_subscriptions run advances nothing further',
    jsonb_array_length(v_advanced) = 0);
  perform test_assert('TZK-U still has exactly 2 subscription_events (no duplicate transition)',
    (select count(*) from subscription_events where subscription_id = '26800003-0000-0000-0000-000000000001') = 2);
  perform test_assert('TZN-U still has exactly 2 subscription_events (no duplicate transition)',
    (select count(*) from subscription_events where subscription_id = '26800005-0000-0000-0000-000000000001') = 2);
  perform test_assert('TZK-X still has exactly 2 subscription_events (no duplicate transition)',
    (select count(*) from subscription_events where subscription_id = '26800006-0000-0000-0000-000000000001') = 2);
  raise notice 'OK: the corrected advance_overdue_subscriptions remains idempotent under rerun';
end;
$$;

reset role;

-- ===========================================================================
-- SECTION B -- send_due_billing_reminders lifecycle-state filter
-- ===========================================================================
--
-- Companies, each with one PENDING subscription invoice due today (local):
--   RCANC (cancelled)             -- must get NO reminder
--   RCLOS (closed)                -- must get NO reminder
--   RONB  (onboarding)            -- must get NO reminder
--   RACT  (active)                -- must get due_today reminder
--   RPD   (payment_due)           -- must get due_today reminder
--   RGRACE (grace_period)         -- must get grace_period_started reminder
--   RCAPE (cancel_at_period_end)  -- must STILL get due_today reminder
--     (deliberately included: not service-blocked, fully billable up to its
--      current period end per packages/billing/src/stateMachine.ts)
-- ===========================================================================

do $$
declare
  v_today date := (now() at time zone 'UTC')::date;
begin
  insert into companies (id, name, slug, status, is_demo, timezone) values
    ('c6100011-0000-0000-0000-000000000001', 'M31 RCANC (cancelled)', 'm31-rcanc', 'active', true, 'UTC'),
    ('c6100012-0000-0000-0000-000000000001', 'M31 RCLOS (closed)', 'm31-rclos', 'active', true, 'UTC'),
    ('c6100013-0000-0000-0000-000000000001', 'M31 RONB (onboarding)', 'm31-ronb', 'onboarding', true, 'UTC'),
    ('c6100014-0000-0000-0000-000000000001', 'M31 RACT (active)', 'm31-ract', 'active', true, 'UTC'),
    ('c6100015-0000-0000-0000-000000000001', 'M31 RPD (payment_due)', 'm31-rpd', 'active', true, 'UTC'),
    ('c6100016-0000-0000-0000-000000000001', 'M31 RGRACE (grace_period)', 'm31-rgrace', 'active', true, 'UTC'),
    ('c6100017-0000-0000-0000-000000000001', 'M31 RCAPE (cancel_at_period_end)', 'm31-rcape', 'active', true, 'UTC');

  insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end, grace_period_end) values
    ('26800011-0000-0000-0000-000000000001', 'c6100011-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'cancelled', now() - interval '35 days', now() - interval '5 days', null),
    ('26800012-0000-0000-0000-000000000001', 'c6100012-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'closed', now() - interval '35 days', now() - interval '5 days', null),
    ('26800013-0000-0000-0000-000000000001', 'c6100013-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'onboarding', null, null, null),
    ('26800014-0000-0000-0000-000000000001', 'c6100014-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'active', now() - interval '25 days', now() + interval '5 days', null),
    ('26800015-0000-0000-0000-000000000001', 'c6100015-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'payment_due', now() - interval '32 days', now() - interval '2 days', null),
    ('26800016-0000-0000-0000-000000000001', 'c6100016-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'grace_period', now() - interval '40 days', now() - interval '10 days', now() + interval '2 days'),
    ('26800017-0000-0000-0000-000000000001', 'c6100017-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'cancel_at_period_end', now() - interval '25 days', now() + interval '5 days', null);

  -- Each company gets one pending subscription invoice due today (local) --
  -- except RACT/RCAPE, due in 3 days, and RPD, also due today (already past
  -- its original due date, hence why it is in payment_due).
  insert into invoices (company_id, kind, invoice_number, status, currency, subtotal, tax, discount, total, due_date, billing_period_start, billing_period_end) values
    ('c6100011-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000011', 'pending', 'INR', 999,0,0,999, v_today, v_today - 30, v_today),
    ('c6100012-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000012', 'pending', 'INR', 999,0,0,999, v_today, v_today - 30, v_today),
    ('c6100013-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000013', 'pending', 'INR', 999,0,0,999, v_today, v_today - 30, v_today),
    ('c6100014-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000014', 'pending', 'INR', 999,0,0,999, v_today, v_today - 30, v_today),
    ('c6100015-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000015', 'pending', 'INR', 999,0,0,999, v_today, v_today - 30, v_today),
    ('c6100016-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000016', 'pending', 'INR', 999,0,0,999, v_today, v_today - 30, v_today),
    ('c6100017-0000-0000-0000-000000000001', 'subscription', 'DRV-M31-TESTFIX-000017', 'pending', 'INR', 999,0,0,999, v_today, v_today - 30, v_today);
end;
$$;

set local role service_role;

do $$
begin
  perform 1 from send_due_billing_reminders();

  perform test_assert('cancelled subscription + pending invoice -> zero new reminder',
    not exists (select 1 from billing_reminders where company_id = 'c6100011-0000-0000-0000-000000000001'));
  perform test_assert('closed subscription + pending invoice -> zero new reminder',
    not exists (select 1 from billing_reminders where company_id = 'c6100012-0000-0000-0000-000000000001'));
  perform test_assert('onboarding subscription + pending invoice -> zero new reminder',
    not exists (select 1 from billing_reminders where company_id = 'c6100013-0000-0000-0000-000000000001'));

  perform test_assert('active subscription at the due_today threshold still gets its reminder',
    (select stage from billing_reminders where company_id = 'c6100014-0000-0000-0000-000000000001') = 'due_today');
  perform test_assert('payment_due subscription at the due_today threshold still gets its reminder (classified by days-remaining exactly like active)',
    (select stage from billing_reminders where company_id = 'c6100015-0000-0000-0000-000000000001') = 'due_today');
  perform test_assert('grace_period subscription gets the grace_period_started reminder, not a days-remaining stage',
    (select stage from billing_reminders where company_id = 'c6100016-0000-0000-0000-000000000001') = 'grace_period_started');
  perform test_assert('cancel_at_period_end subscription still gets its reminder -- not service-blocked, fully billable up to its current period end',
    (select stage from billing_reminders where company_id = 'c6100017-0000-0000-0000-000000000001') = 'due_today');

  perform test_assert('exactly 4 reminders were created (RACT, RPD, RGRACE, RCAPE) and none for RCANC/RCLOS/RONB',
    (select count(*) from billing_reminders where company_id in (
      'c6100011-0000-0000-0000-000000000001', 'c6100012-0000-0000-0000-000000000001', 'c6100013-0000-0000-0000-000000000001',
      'c6100014-0000-0000-0000-000000000001', 'c6100015-0000-0000-0000-000000000001', 'c6100016-0000-0000-0000-000000000001',
      'c6100017-0000-0000-0000-000000000001'
    )) = 4);

  raise notice 'OK: send_due_billing_reminders now correctly excludes cancelled/closed/onboarding subscriptions while every valid billable state (active, payment_due, grace_period, cancel_at_period_end) continues to receive its correct reminder stage';
end;
$$;

-- Rerun: no duplicates, and the excluded companies remain untouched.
do $$
begin
  perform 1 from send_due_billing_reminders();
  perform test_assert('RACT still has exactly one reminder after rerun',
    (select count(*) from billing_reminders where company_id = 'c6100014-0000-0000-0000-000000000001') = 1);
  perform test_assert('RPD still has exactly one reminder after rerun',
    (select count(*) from billing_reminders where company_id = 'c6100015-0000-0000-0000-000000000001') = 1);
  perform test_assert('RGRACE still has exactly one reminder after rerun',
    (select count(*) from billing_reminders where company_id = 'c6100016-0000-0000-0000-000000000001') = 1);
  perform test_assert('RCAPE still has exactly one reminder after rerun',
    (select count(*) from billing_reminders where company_id = 'c6100017-0000-0000-0000-000000000001') = 1);
  perform test_assert('RCANC/RCLOS/RONB still have zero reminders after rerun',
    not exists (select 1 from billing_reminders where company_id in (
      'c6100011-0000-0000-0000-000000000001', 'c6100012-0000-0000-0000-000000000001', 'c6100013-0000-0000-0000-000000000001'
    )));
  raise notice 'OK: the corrected send_due_billing_reminders remains idempotent under rerun, and the excluded companies stay excluded';
end;
$$;

do $$
begin
  perform test_assert('company isolation preserved: no cross-company notification leakage among the section B fixtures',
    (select count(*) from notifications where company_id = 'c6100014-0000-0000-0000-000000000001') = 1
    and (select count(*) from notifications where company_id = 'c6100014-0000-0000-0000-000000000001' and body like '%RPD%') = 0);
  raise notice 'OK: company isolation preserved across the reminder-filter fixtures';
end;
$$;

reset role;

-- ===========================================================================
-- SECTION C -- billing_invoice_number_seq privilege hardening
-- ===========================================================================

do $$
begin
  perform test_assert('anon cannot USE billing_invoice_number_seq after migration 31',
    not has_sequence_privilege('anon', 'public.billing_invoice_number_seq', 'USAGE'));
  perform test_assert('anon cannot SELECT billing_invoice_number_seq after migration 31',
    not has_sequence_privilege('anon', 'public.billing_invoice_number_seq', 'SELECT'));
  perform test_assert('anon cannot UPDATE billing_invoice_number_seq after migration 31',
    not has_sequence_privilege('anon', 'public.billing_invoice_number_seq', 'UPDATE'));
  perform test_assert('authenticated cannot USE billing_invoice_number_seq after migration 31',
    not has_sequence_privilege('authenticated', 'public.billing_invoice_number_seq', 'USAGE'));
  perform test_assert('authenticated cannot SELECT billing_invoice_number_seq after migration 31',
    not has_sequence_privilege('authenticated', 'public.billing_invoice_number_seq', 'SELECT'));
  perform test_assert('authenticated cannot UPDATE billing_invoice_number_seq after migration 31',
    not has_sequence_privilege('authenticated', 'public.billing_invoice_number_seq', 'UPDATE'));
  raise notice 'OK: billing_invoice_number_seq no longer grants anon/authenticated direct USAGE/SELECT/UPDATE';
end;
$$;

do $$
declare
  v_company uuid := 'c6100021-0000-0000-0000-000000000001';
  v_generated jsonb;
  v_numbers text[];
begin
  insert into companies (id, name, slug, status, is_demo, timezone) values
    (v_company, 'M31 SEQ (invoice-number-after-acl-hardening)', 'm31-seq', 'active', true, 'UTC');
  insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end) values
    ('26800021-0000-0000-0000-000000000001', v_company, '26700001-0000-0000-0000-000000000001', 'active', now() - interval '25 days', now() + interval '5 days');

  set local role service_role;
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_generated from generate_due_subscription_invoices() g;
  reset role;

  perform test_assert('generate_due_subscription_invoices (SECURITY DEFINER, owned by the sequence''s own owner) still successfully creates an invoice after the ACL correction',
    (select count(*) from invoices where company_id = v_company) = 1);
  perform test_assert('the generated invoice number still matches the DRV-<year>-<6 digits> format, backed by the now-hardened sequence',
    (select invoice_number ~ '^DRV-\d{4}-\d{6}$' from invoices where company_id = v_company));

  -- Uniqueness: generate two more invoices for two more companies and confirm
  -- all invoice numbers so far remain distinct (sequence-backed numbering
  -- still produces no collisions after the ACL correction).
  insert into companies (id, name, slug, status, is_demo, timezone) values
    ('c6100022-0000-0000-0000-000000000001', 'M31 SEQ2', 'm31-seq2', 'active', true, 'UTC'),
    ('c6100023-0000-0000-0000-000000000001', 'M31 SEQ3', 'm31-seq3', 'active', true, 'UTC');
  insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end) values
    ('26800022-0000-0000-0000-000000000001', 'c6100022-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'active', now() - interval '25 days', now() + interval '5 days'),
    ('26800023-0000-0000-0000-000000000001', 'c6100023-0000-0000-0000-000000000001', '26700001-0000-0000-0000-000000000001', 'active', now() - interval '25 days', now() + interval '5 days');

  set local role service_role;
  perform generate_due_subscription_invoices();
  reset role;

  select array_agg(invoice_number) into v_numbers from invoices where invoice_number ~ '^DRV-';
  perform test_assert('all sequence-backed DRV-* invoice numbers generated in this test remain unique',
    array_length(v_numbers, 1) = (select count(distinct x) from unnest(v_numbers) x));

  raise notice 'OK: the invoice-numbering execution path (SECURITY DEFINER, object-owner privileges) is completely unaffected by revoking anon/authenticated from the sequence, and numbering remains unique';
end;
$$;

rollback;
