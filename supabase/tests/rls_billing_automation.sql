-- Phase 6C: staging billing automation (migration 30) RLS/RPC hardening
-- tests. Run after rls_razorpay_payments.sql (via supabase/tests/run.sh),
-- against the same throwaway local Postgres database -- never a hosted
-- Supabase project.
--
-- Migrations 28/29's own regression coverage (repeated Pay Now protection,
-- unknown-order safety, amount/currency validation, duplicate-captured
-- idempotency, trial->active activation) already re-runs against this same
-- migrated function set every time this whole suite executes (this file
-- only adds NEW Phase 6C coverage) -- see rls_razorpay_payments.sql.

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
-- Hardening sweep: every migration 30 RPC has an empty search_path; the four
-- scheduler RPCs are service_role-only; the admin overview RPC is
-- authenticated-callable but gates internally on super_admin.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  service_role_only_fns text[] := array['generate_due_subscription_invoices', 'advance_overdue_subscriptions', 'suspend_expired_grace_subscriptions', 'send_due_billing_reminders'];
  authenticated_fns text[] := array['admin_billing_lifecycle_overview'];
begin
  foreach fn in array (service_role_only_fns || authenticated_fns)
  loop
    if not exists (
      select 1 from pg_proc p
      where p.proname = fn
        and exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%' and cfg not like 'search_path=%public%')
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

select test_assert(
  'invoices_subscription_cycle_key partial unique index exists on (company_id, billing_period_start, billing_period_end)',
  exists (select 1 from pg_indexes where indexname = 'invoices_subscription_cycle_key')
);

-- ---------------------------------------------------------------------------
-- Fixtures. Company A: active, renewal due in 5 days (unpaid). Company B:
-- trial, ends in 3 days. Company C: active, already lapsed + unpaid
-- (overdue candidate). Company D: active, lapsed but ALREADY paid for that
-- cycle (must be excluded). Company E: cancelled. Company F: closed.
-- Company G: America/New_York (non-UTC, for timezone boundary checks).
-- Company H: a second super-admin-overview target.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('e6000001-0000-0000-0000-000000000001', 'owner-a-billauto@example.test'),
  ('e6000009-0000-0000-0000-000000000001', 'superadmin-billauto@example.test');

insert into companies (id, name, slug, status, is_demo, timezone) values
  ('c6000001-0000-0000-0000-000000000001', 'BillAuto Co A (active, due soon)', 'billauto-a', 'active', true, 'UTC'),
  ('c6000002-0000-0000-0000-000000000001', 'BillAuto Co B (trial, ends soon)', 'billauto-b', 'active', true, 'UTC'),
  ('c6000003-0000-0000-0000-000000000001', 'BillAuto Co C (active, lapsed unpaid)', 'billauto-c', 'active', true, 'UTC'),
  ('c6000004-0000-0000-0000-000000000001', 'BillAuto Co D (active, lapsed but paid)', 'billauto-d', 'active', true, 'UTC'),
  ('c6000005-0000-0000-0000-000000000001', 'BillAuto Co E (cancelled)', 'billauto-e', 'active', true, 'UTC'),
  ('c6000006-0000-0000-0000-000000000001', 'BillAuto Co F (closed)', 'billauto-f', 'active', true, 'UTC'),
  ('c6000007-0000-0000-0000-000000000001', 'BillAuto Co G (non-UTC tz)', 'billauto-g', 'active', true, 'America/New_York');

insert into company_members (id, company_id, user_id, role, is_active) values
  ('b6000001-0000-0000-0000-000000000001', 'c6000001-0000-0000-0000-000000000001', 'e6000001-0000-0000-0000-000000000001', 'company_owner', true);

insert into platform_members (user_id, role, is_active) values
  ('e6000009-0000-0000-0000-000000000001', 'super_admin', true);

insert into plans (id, key, name, is_active) values
  ('16600001-0000-0000-0000-000000000001', 'billauto-plan', 'BillAuto Plan', true);
insert into plan_versions (id, plan_id, version, monthly_price, currency, is_current, grace_period_days) values
  ('16700001-0000-0000-0000-000000000001', '16600001-0000-0000-0000-000000000001', 1, 999.00, 'INR', true, 4);

insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end) values
  ('16800001-0000-0000-0000-000000000001', 'c6000001-0000-0000-0000-000000000001', '16700001-0000-0000-0000-000000000001', 'active', now() - interval '25 days', now() + interval '5 days'),
  ('16800002-0000-0000-0000-000000000001', 'c6000002-0000-0000-0000-000000000001', '16700001-0000-0000-0000-000000000001', 'trial', now() - interval '11 days', now() + interval '3 days'),
  ('16800003-0000-0000-0000-000000000001', 'c6000003-0000-0000-0000-000000000001', '16700001-0000-0000-0000-000000000001', 'active', now() - interval '35 days', now() - interval '2 days'),
  ('16800004-0000-0000-0000-000000000001', 'c6000004-0000-0000-0000-000000000001', '16700001-0000-0000-0000-000000000001', 'active', now() - interval '35 days', now() - interval '2 days'),
  ('16800005-0000-0000-0000-000000000001', 'c6000005-0000-0000-0000-000000000001', '16700001-0000-0000-0000-000000000001', 'cancelled', now() - interval '35 days', now() - interval '2 days'),
  ('16800006-0000-0000-0000-000000000001', 'c6000006-0000-0000-0000-000000000001', '16700001-0000-0000-0000-000000000001', 'closed', now() - interval '35 days', now() - interval '2 days'),
  ('16800007-0000-0000-0000-000000000001', 'c6000007-0000-0000-0000-000000000001', '16700001-0000-0000-0000-000000000001', 'active', now() - interval '25 days', now() + interval '5 days');

-- Company D's already-paid cycle invoice (must exclude it from overdue advancement).
insert into invoices (id, company_id, kind, invoice_number, status, currency, subtotal, tax, discount, total, due_date, billing_period_start, billing_period_end)
values ('16900004-0000-0000-0000-000000000001', 'c6000004-0000-0000-0000-000000000001', 'subscription', 'DRV-PRESEED-000001', 'paid', 'INR', 999.00, 0, 0, 999.00,
  (now() - interval '2 days')::date, (now() - interval '35 days')::date, (now() - interval '2 days')::date);

set local role service_role;

-- ---------------------------------------------------------------------------
-- 1. generate_due_subscription_invoices: one invoice per eligible
--    subscription, correct price/currency, correct company-local billing
--    period, exactly one invoice_generated audit row. Cancelled/closed and
--    already-lapsed-but-not-within-7-days subscriptions are excluded.
-- ---------------------------------------------------------------------------

do $$
declare
  v_generated jsonb;
  v_count int;
begin
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_generated from generate_due_subscription_invoices() g;

  -- Company C is deliberately seeded already lapsed with no prior invoice at
  -- all (simulating a subscription that predates the scheduler existing) --
  -- current_period_end in the past still satisfies "<= now() + 7 days", so
  -- the generator correctly self-heals it with a (past-dated) invoice too,
  -- rather than leaving it permanently un-invoiced. This is intentional:
  -- a gap-backfill is safer than a silent gap.
  perform test_assert('generate_due_subscription_invoices generated invoices for exactly Company A, B, C, and G (every trial/active subscription within 7 days of its period end, including an already-lapsed one with no prior invoice)',
    (select count(*) from jsonb_array_elements(v_generated) e where e->>'company_id' = 'c6000001-0000-0000-0000-000000000001') = 1
    and (select count(*) from jsonb_array_elements(v_generated) e where e->>'company_id' = 'c6000002-0000-0000-0000-000000000001') = 1
    and (select count(*) from jsonb_array_elements(v_generated) e where e->>'company_id' = 'c6000003-0000-0000-0000-000000000001') = 1
    and (select count(*) from jsonb_array_elements(v_generated) e where e->>'company_id' = 'c6000007-0000-0000-0000-000000000001') = 1
    and jsonb_array_length(v_generated) = 4);

  perform test_assert('Company D (already lapsed but already has a PAID invoice for its exact cycle) gets no second invoice -- the unique cycle index catches it as a no-op',
    not exists (select 1 from jsonb_array_elements(v_generated) e where e->>'company_id' = 'c6000004-0000-0000-0000-000000000001')
    and (select count(*) from invoices where company_id = 'c6000004-0000-0000-0000-000000000001') = 1);
  perform test_assert('Company E (cancelled) never gets an invoice generated',
    not exists (select 1 from invoices where company_id = 'c6000005-0000-0000-0000-000000000001'));
  perform test_assert('Company F (closed) never gets an invoice generated',
    not exists (select 1 from invoices where company_id = 'c6000006-0000-0000-0000-000000000001'));

  perform test_assert('Company A''s generated invoice has the plan_version''s own price/currency, never client-supplied',
    (select total = 999.00 and currency = 'INR' from invoices where company_id = 'c6000001-0000-0000-0000-000000000001'));
  perform test_assert('Company A''s invoice number matches the DRV-<year>-<6 digits> format',
    (select invoice_number ~ '^DRV-\d{4}-\d{6}$' from invoices where company_id = 'c6000001-0000-0000-0000-000000000001'));
  perform test_assert('Company A''s invoice billing_period_end equals the subscription''s current_period_end (UTC company)',
    (select i.billing_period_end = (s.current_period_end at time zone 'UTC')::date
     from invoices i join subscriptions s on s.company_id = i.company_id where i.company_id = 'c6000001-0000-0000-0000-000000000001'));
  perform test_assert('exactly one invoice_generated audit row exists for Company A',
    (select count(*) from audit_logs where company_id = 'c6000001-0000-0000-0000-000000000001' and action = 'invoice_generated') = 1);

  select count(*) into v_count from invoices;
  perform test_assert('exactly 5 invoices exist total (A, B, C, G generated + D''s pre-seeded paid one)', v_count = 5);
  raise notice 'OK: generate_due_subscription_invoices produces exactly one correctly-priced invoice per eligible subscription, excluding cancelled/closed, and self-heals a gap without duplicating an existing paid cycle';
end;
$$;

-- 2. Rerun does not duplicate (idempotency).
do $$
declare
  v_generated jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_generated from generate_due_subscription_invoices() g;
  perform test_assert('a second scheduler run produces zero new invoices (the unique_violation catch made it a no-op)',
    jsonb_array_length(v_generated) = 0);
  perform test_assert('still exactly 5 invoices total after the rerun',
    (select count(*) from invoices) = 5);
  perform test_assert('still exactly one invoice_generated audit row for Company A after the rerun',
    (select count(*) from audit_logs where company_id = 'c6000001-0000-0000-0000-000000000001' and action = 'invoice_generated') = 1);
  raise notice 'OK: repeated scheduler execution never duplicates an invoice for the same billing cycle';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. advance_overdue_subscriptions: Company C (active, lapsed, unpaid) goes
--    payment_due -> grace_period in one pass, using the correct grace
--    duration from its plan_version; Company D (lapsed but already paid)
--    and Company A/B/G (not yet lapsed) are untouched.
-- ---------------------------------------------------------------------------

do $$
declare
  v_advanced jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_advanced from advance_overdue_subscriptions() g;

  perform test_assert('advance_overdue_subscriptions advanced exactly Company C',
    jsonb_array_length(v_advanced) = 1 and v_advanced->0->>'company_id' = 'c6000003-0000-0000-0000-000000000001');
  perform test_assert('Company C is now in grace_period',
    (select state from subscriptions where company_id = 'c6000003-0000-0000-0000-000000000001') = 'grace_period');
  perform test_assert('Company C''s grace_period_end is exactly its own lapsed current_period_end + grace_period_days (4 days, from its plan_version) -- never "now" + grace days, which would unfairly reward a delayed scheduler run',
    (select grace_period_end = (now() - interval '2 days') + interval '4 days' from subscriptions where company_id = 'c6000003-0000-0000-0000-000000000001'));
  perform test_assert('Company C recorded BOTH canonical events in order: payment_failed (active->payment_due) then grace_period_started (payment_due->grace_period)',
    (select array_agg(event order by created_at) from subscription_events where subscription_id = '16800003-0000-0000-0000-000000000001') = array['payment_failed', 'grace_period_started']);
  perform test_assert('Company C got both a payment_due and a grace_period_started audit row',
    (select count(*) from audit_logs where company_id = 'c6000003-0000-0000-0000-000000000001' and action in ('payment_due', 'grace_period_started')) = 2);

  perform test_assert('Company D (lapsed but its cycle invoice is already paid) is correctly excluded and remains active',
    (select state from subscriptions where company_id = 'c6000004-0000-0000-0000-000000000001') = 'active');
  perform test_assert('Company A (not yet lapsed) is untouched',
    (select state from subscriptions where company_id = 'c6000001-0000-0000-0000-000000000001') = 'active');
  raise notice 'OK: an overdue unpaid subscription advances through payment_due into grace_period using the plan''s own grace_period_days, in one pass, using only canonical events';
end;
$$;

-- Rerun idempotency for advance_overdue_subscriptions: Company C is now in
-- grace_period, so a second run must not re-fire either event again.
do $$
declare
  v_advanced jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_advanced from advance_overdue_subscriptions() g;
  perform test_assert('a second advance_overdue_subscriptions run advances nothing further (Company C already left trial/active)',
    jsonb_array_length(v_advanced) = 0);
  perform test_assert('Company C still has exactly 2 subscription_events (no duplicate transition)',
    (select count(*) from subscription_events where subscription_id = '16800003-0000-0000-0000-000000000001') = 2);
  raise notice 'OK: advance_overdue_subscriptions is idempotent under rerun';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Trial expired unpaid -> payment_due uses trial_ended_without_payment,
--    never payment_failed. Fresh fixture (Company B is still an active
--    trial with 3 days left; use a NEW company for the expired-trial case).
-- ---------------------------------------------------------------------------

insert into companies (id, name, slug, status, is_demo, timezone) values ('c6000008-0000-0000-0000-000000000001', 'BillAuto Co H (trial expired unpaid)', 'billauto-h', 'active', true, 'UTC');
insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end) values
  ('16800008-0000-0000-0000-000000000001', 'c6000008-0000-0000-0000-000000000001', '16700001-0000-0000-0000-000000000001', 'trial', now() - interval '15 days', now() - interval '1 days');

do $$
begin
  perform advance_overdue_subscriptions();
  perform test_assert('an expired unpaid trial uses trial_ended_without_payment (never payment_failed) for its trial->payment_due transition',
    (select event from subscription_events where subscription_id = '16800008-0000-0000-0000-000000000001' and from_state = 'trial') = 'trial_ended_without_payment');
  perform test_assert('the expired trial subscription is now in grace_period (same cascaded pass as any other lapsed subscription)',
    (select state from subscriptions where company_id = 'c6000008-0000-0000-0000-000000000001') = 'grace_period');
  raise notice 'OK: an expired unpaid trial correctly uses the canonical trial_ended_without_payment event, not payment_failed';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. suspend_expired_grace_subscriptions: only fires once grace_period_end
--    has actually passed. Company C's grace period (4 days from ~2 days
--    ago) has NOT expired yet -- must not suspend it prematurely. A fresh
--    company with an already-expired grace period must be suspended.
-- ---------------------------------------------------------------------------

insert into companies (id, name, slug, status, is_demo, timezone) values ('c6000009-0000-0000-0000-000000000001', 'BillAuto Co I (grace expired)', 'billauto-i', 'active', true, 'UTC');
insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end, grace_period_end) values
  ('16800009-0000-0000-0000-000000000001', 'c6000009-0000-0000-0000-000000000001', '16700001-0000-0000-0000-000000000001', 'grace_period', now() - interval '40 days', now() - interval '10 days', now() - interval '1 days');

do $$
declare v_suspended jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_suspended from suspend_expired_grace_subscriptions() g;

  perform test_assert('only Company I (expired grace) is suspended -- Company C (grace not yet expired) is untouched',
    jsonb_array_length(v_suspended) = 1 and v_suspended->0->>'company_id' = 'c6000009-0000-0000-0000-000000000001');
  perform test_assert('Company C (grace still active) remains in grace_period, not suspended',
    (select state from subscriptions where company_id = 'c6000003-0000-0000-0000-000000000001') = 'grace_period');
  perform test_assert('Company I is now suspended (never manually_suspended)',
    (select state from subscriptions where company_id = 'c6000009-0000-0000-0000-000000000001') = 'suspended');
  perform test_assert('Company I recorded the canonical grace_period_expired event',
    (select event from subscription_events where subscription_id = '16800009-0000-0000-0000-000000000001' and to_state = 'suspended') = 'grace_period_expired');
  perform test_assert('a subscription_suspended audit row was recorded for Company I',
    exists (select 1 from audit_logs where company_id = 'c6000009-0000-0000-0000-000000000001' and action = 'subscription_suspended'));
  raise notice 'OK: only a subscription whose grace period has actually expired is suspended, via the canonical grace_period_expired event, never manually_suspended';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Payment recovery during payment_due/grace_period/suspended still works
--    exactly as migrations 28/29 already guarantee (regression, using the
--    scheduler-produced states above rather than hand-seeded ones).
-- ---------------------------------------------------------------------------

do $$
declare v_payment_id uuid;
begin
  -- Company C is in grace_period (from step 3). Pay its outstanding cycle invoice.
  select id into v_payment_id from invoices where company_id = 'c6000003-0000-0000-0000-000000000001' and status = 'pending' limit 1;
  insert into payments (company_id, invoice_id, method, status, amount, currency, provider_reference)
    values ('c6000003-0000-0000-0000-000000000001', v_payment_id, 'razorpay', 'pending', 999.00, 'INR', 'order_BILLAUTO_C_RECOVERY')
    returning id into v_payment_id;
  perform reconcile_razorpay_payment('payment.captured:pay_BILLAUTO_C_RECOVERY', 'captured', 'order_BILLAUTO_C_RECOVERY', 'pay_BILLAUTO_C_RECOVERY', 99900, 'INR', '{}'::jsonb);

  perform test_assert('Company C (was grace_period) recovers to active on successful payment (existing Phase 6B payment_recovered behavior, unchanged)',
    (select state from subscriptions where company_id = 'c6000003-0000-0000-0000-000000000001') = 'active');
  raise notice 'OK: existing Phase 6B payment recovery continues to work correctly against a scheduler-produced grace_period state';
end;
$$;

do $$
declare v_invoice_id uuid; v_payment_id uuid;
begin
  -- Company I is suspended (from step 5). Its cycle invoice was never generated by this test (pre-existed as none) -- create one and pay it.
  insert into invoices (id, company_id, kind, invoice_number, status, currency, subtotal, tax, discount, total, due_date)
    values ('16900009-0000-0000-0000-000000000002', 'c6000009-0000-0000-0000-000000000001', 'subscription', 'DRV-TESTFIX-000002', 'pending', 'INR', 999.00, 0, 0, 999.00, current_date)
    returning id into v_invoice_id;
  insert into payments (company_id, invoice_id, method, status, amount, currency, provider_reference)
    values ('c6000009-0000-0000-0000-000000000001', v_invoice_id, 'razorpay', 'pending', 999.00, 'INR', 'order_BILLAUTO_I_RECOVERY')
    returning id into v_payment_id;
  perform reconcile_razorpay_payment('payment.captured:pay_BILLAUTO_I_RECOVERY', 'captured', 'order_BILLAUTO_I_RECOVERY', 'pay_BILLAUTO_I_RECOVERY', 99900, 'INR', '{}'::jsonb);

  perform test_assert('Company I (was suspended) recovers to active on successful payment',
    (select state from subscriptions where company_id = 'c6000009-0000-0000-0000-000000000001') = 'active');
  raise notice 'OK: existing Phase 6B payment recovery continues to work correctly against a scheduler-produced suspended state';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. send_due_billing_reminders: correct stage classification per company,
--    company-local timezone respected, exactly-once per (invoice, stage),
--    company-wide visibility via the existing notifications RLS policy.
-- ---------------------------------------------------------------------------

do $$
declare
  v_sent jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_sent from send_due_billing_reminders() g;

  perform test_assert('Company A (due in 5 days) gets no reminder yet -- 5 is not one of the configured stages (7/3/1/0)',
    not exists (select 1 from billing_reminders where company_id = 'c6000001-0000-0000-0000-000000000001'));
  perform test_assert('Company B (trial invoice due in 3 days) gets exactly the due_in_3 reminder',
    (select stage from billing_reminders where company_id = 'c6000002-0000-0000-0000-000000000001') = 'due_in_3');
  perform test_assert('exactly one notifications row was created for Company B, company-wide (recipient_user_id null), audience company_admin, category renewal_upcoming',
    (select count(*) from notifications where company_id = 'c6000002-0000-0000-0000-000000000001') = 1
    and (select recipient_user_id is null and audience = 'company_admin' and category = 'renewal_upcoming' from notifications where company_id = 'c6000002-0000-0000-0000-000000000001'));
  raise notice 'OK: reminders are classified into the correct stage and only fire for invoices actually at a configured threshold';
end;
$$;

do $$
declare v_sent jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb) into v_sent from send_due_billing_reminders() g;
  perform test_assert('a second reminder run for Company B sends nothing further (already recorded due_in_3)',
    not exists (select 1 from jsonb_array_elements(v_sent) e where e->>'company_id' = 'c6000002-0000-0000-0000-000000000001'));
  perform test_assert('Company B still has exactly one billing_reminders row and one notifications row',
    (select count(*) from billing_reminders where company_id = 'c6000002-0000-0000-0000-000000000001') = 1
    and (select count(*) from notifications where company_id = 'c6000002-0000-0000-0000-000000000001') = 1);
  raise notice 'OK: reminder sending is idempotent per (invoice, stage) under rerun';
end;
$$;

do $$
begin
  perform test_assert('Company C (recovered to active in step 6, invoice now paid) gets no grace_period_started reminder despite having been in grace_period earlier',
    not exists (select 1 from billing_reminders where company_id = 'c6000003-0000-0000-0000-000000000001'));
  raise notice 'OK: a paid invoice never enters the reminder workflow (status filter excludes it up front)';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Timezone boundary: Company G's America/New_York invoice due_date must
--    be computed from company-local (not UTC) calendar dates.
-- ---------------------------------------------------------------------------

do $$
declare
  v_expected_local_due date;
begin
  select (s.current_period_end at time zone 'America/New_York')::date into v_expected_local_due
    from subscriptions s where s.company_id = 'c6000007-0000-0000-0000-000000000001';

  perform test_assert('Company G''s (America/New_York) invoice due_date is computed in company-local time, not UTC',
    (select due_date from invoices where company_id = 'c6000007-0000-0000-0000-000000000001') = v_expected_local_due);
  raise notice 'OK: invoice billing-period dates respect company.timezone, not a hardcoded UTC/Asia-Kolkata assumption';
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Cross-tenant isolation across the whole scheduler pipeline: nothing
--    done for Company A/B/C/G/H/I ever touched Company D, E, or F's own
--    rows beyond what was asserted above.
-- ---------------------------------------------------------------------------

do $$
begin
  perform test_assert('Company D (excluded from advancement) has no subscription_events at all',
    not exists (select 1 from subscription_events where subscription_id = '16800004-0000-0000-0000-000000000001'));
  perform test_assert('Company E (cancelled) has no subscription_events, invoices, or reminders from this run',
    not exists (select 1 from subscription_events where subscription_id = '16800005-0000-0000-0000-000000000001')
    and not exists (select 1 from invoices where company_id = 'c6000005-0000-0000-0000-000000000001')
    and not exists (select 1 from billing_reminders where company_id = 'c6000005-0000-0000-0000-000000000001'));
  perform test_assert('Company F (closed) has no subscription_events, invoices, or reminders from this run',
    not exists (select 1 from subscription_events where subscription_id = '16800006-0000-0000-0000-000000000001')
    and not exists (select 1 from invoices where company_id = 'c6000006-0000-0000-0000-000000000001')
    and not exists (select 1 from billing_reminders where company_id = 'c6000006-0000-0000-0000-000000000001'));
  raise notice 'OK: the full scheduler pipeline is tenant-isolated by construction -- excluded companies are never touched';
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 10. admin_billing_lifecycle_overview: super_admin only, correct
--     overdue/days_until_due/last_paid fields.
-- ---------------------------------------------------------------------------

set local role authenticated;
select test_set_current_user('e6000001-0000-0000-0000-000000000001'); -- owner-a, NOT platform staff

select test_assert_raises_like(
  'a regular company owner (not platform staff) cannot call admin_billing_lifecycle_overview',
  $sql$ select * from admin_billing_lifecycle_overview() $sql$,
  'permission_denied'
);

select test_set_current_user('e6000009-0000-0000-0000-000000000001'); -- super_admin

do $$
declare
  v_row record;
begin
  select * into v_row from admin_billing_lifecycle_overview() where company_id = 'c6000009-0000-0000-0000-000000000001';
  perform test_assert('admin_billing_lifecycle_overview reports Company I (recovered to active in step 6) with its last-paid invoice date/amount populated',
    v_row.subscription_state = 'active' and v_row.last_paid_date = current_date and v_row.last_paid_amount = 999.00);

  select * into v_row from admin_billing_lifecycle_overview() where company_id = 'c6000001-0000-0000-0000-000000000001';
  perform test_assert('admin_billing_lifecycle_overview correctly reports Company A as NOT overdue (due in 5 days, still pending)',
    v_row.is_overdue = false and v_row.days_until_due = 5 and v_row.latest_invoice_status = 'pending');

  raise notice 'OK: admin_billing_lifecycle_overview is super_admin-gated and reports correct overdue/days-until-due/last-paid data';
end;
$$;

reset role;

rollback;
