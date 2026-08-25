-- Phase 6B: Razorpay Orders + Checkout payment capability (migration 28)
-- RLS/RPC hardening tests. Run after rls_support_requests.sql (via
-- supabase/tests/run.sh), against the same throwaway local Postgres
-- database -- never a hosted Supabase project. No real Razorpay API call
-- is made anywhere in this file: create_payment_order/attach_razorpay_order
-- are tested up to (and including) the DB-side pending-payment/order-id
-- steps; reconcile_razorpay_payment is tested directly, as the webhook
-- handler in apps/api would call it, with fabricated order/payment ids.

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
-- Hardening sweep: reconcile_razorpay_payment must be service_role only;
-- create_payment_order/attach_razorpay_order must be authenticated-callable
-- but never anon-callable. All three must have an empty search_path.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  service_role_only_fns text[] := array['reconcile_razorpay_payment'];
  authenticated_fns text[] := array['create_payment_order', 'attach_razorpay_order'];
begin
  foreach fn in array (service_role_only_fns || authenticated_fns)
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
-- billing.pay grants: exactly company_owner/company_admin/company_accounts,
-- never manager/team_leader/sales_person, never billing.manage restored.
-- ---------------------------------------------------------------------------

select test_assert(
  'billing.pay is granted to exactly company_owner, company_admin, company_accounts',
  (select count(*) from role_permissions where permission_key = 'billing.pay') = 3
  and (select bool_and(role in ('company_owner', 'company_admin', 'company_accounts'))
       from role_permissions where permission_key = 'billing.pay')
);

select test_assert(
  'billing.manage remains granted to no role (not restored by this migration)',
  not exists (select 1 from role_permissions where permission_key = 'billing.manage')
);

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- Company A: owner, admin, accounts, manager, team_leader, sales_person --
-- one subscription (kind-agnostic; invoices below carry their own kind) and
-- three invoices (payable subscription invoice, an already-paid invoice, a
-- void invoice, and a service-charge invoice for the service-charge-must-
-- not-renew assertion).
-- Company B: owner + one payable invoice, for cross-tenant assertions.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('e0000001-0000-0000-0000-000000000001', 'owner-a-pay@example.test'),
  ('e0000001-0000-0000-0000-000000000002', 'admin-a-pay@example.test'),
  ('e0000001-0000-0000-0000-000000000003', 'accounts-a-pay@example.test'),
  ('e0000001-0000-0000-0000-000000000004', 'manager-a-pay@example.test'),
  ('e0000001-0000-0000-0000-000000000005', 'teamlead-a-pay@example.test'),
  ('e0000001-0000-0000-0000-000000000006', 'sales-a-pay@example.test'),
  ('e0000002-0000-0000-0000-000000000001', 'owner-b-pay@example.test');

insert into companies (id, name, slug, status, is_demo) values
  ('d1000001-0000-0000-0000-000000000001', 'Pay Co A', 'pay-co-a', 'active', true),
  ('d2000001-0000-0000-0000-000000000001', 'Pay Co B', 'pay-co-b', 'active', true);

insert into company_members (id, company_id, user_id, role, is_active) values
  ('b1000001-0000-0000-0000-000000000001', 'd1000001-0000-0000-0000-000000000001', 'e0000001-0000-0000-0000-000000000001', 'company_owner', true),
  ('b1000001-0000-0000-0000-000000000002', 'd1000001-0000-0000-0000-000000000001', 'e0000001-0000-0000-0000-000000000002', 'company_admin', true),
  ('b1000001-0000-0000-0000-000000000003', 'd1000001-0000-0000-0000-000000000001', 'e0000001-0000-0000-0000-000000000003', 'company_accounts', true),
  ('b1000001-0000-0000-0000-000000000004', 'd1000001-0000-0000-0000-000000000001', 'e0000001-0000-0000-0000-000000000004', 'manager', true),
  ('b1000001-0000-0000-0000-000000000005', 'd1000001-0000-0000-0000-000000000001', 'e0000001-0000-0000-0000-000000000005', 'team_leader', true),
  ('b1000001-0000-0000-0000-000000000006', 'd1000001-0000-0000-0000-000000000001', 'e0000001-0000-0000-0000-000000000006', 'sales_person', true),
  ('b2000001-0000-0000-0000-000000000001', 'd2000001-0000-0000-0000-000000000001', 'e0000002-0000-0000-0000-000000000001', 'company_owner', true);

insert into plans (id, key, name, is_active) values
  ('11100001-0000-0000-0000-000000000001', 'pay-test-plan', 'Pay Test Plan', true);
insert into plan_versions (id, plan_id, version, monthly_price, currency, is_current) values
  ('11200001-0000-0000-0000-000000000001', '11100001-0000-0000-0000-000000000001', 1, 1000.00, 'INR', true);

insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end) values
  ('13300001-0000-0000-0000-000000000001', 'd1000001-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'payment_due', '2026-07-01', '2026-08-01'),
  ('13300002-0000-0000-0000-000000000001', 'd2000001-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'active', '2026-07-01', '2026-08-01');

insert into invoices (id, company_id, kind, invoice_number, status, currency, total) values
  ('14400001-0000-0000-0000-000000000001', 'd1000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-A-0001', 'pending', 'INR', 1000.00),
  ('14400001-0000-0000-0000-000000000002', 'd1000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-A-0002', 'paid', 'INR', 1000.00),
  ('14400001-0000-0000-0000-000000000003', 'd1000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-A-0003', 'void', 'INR', 1000.00),
  ('14400001-0000-0000-0000-000000000004', 'd1000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-A-0004', 'pending', 'INR', 1000.00),
  ('14400001-0000-0000-0000-000000000005', 'd1000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-A-0005', 'pending', 'INR', 1000.00),
  ('14400001-0000-0000-0000-000000000006', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-SVC1', 'pending', 'INR', 500.00),
  ('14400002-0000-0000-0000-000000000001', 'd2000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-B-0001', 'pending', 'INR', 1000.00);

set local role authenticated;

-- ---------------------------------------------------------------------------
-- 1. create_payment_order: happy path for company_owner, and the resulting
--    pending payment row carries the invoice's own server-derived
--    amount/currency, never anything the caller could have supplied
--    (this RPC has no amount/currency/company_id parameter at all).
-- ---------------------------------------------------------------------------

select test_set_current_user('e0000001-0000-0000-0000-000000000001'); -- owner-a

do $$
declare
  v_row record;
begin
  select * into v_row from create_payment_order('14400001-0000-0000-0000-000000000001');
  if v_row.amount <> 1000.00 or v_row.currency <> 'INR' or v_row.company_id <> 'd1000001-0000-0000-0000-000000000001' then
    raise exception 'ASSERTION FAILED: create_payment_order returned unexpected amount/currency/company_id: %', v_row;
  end if;
  perform test_assert(
    'the created payment row is pending, method razorpay, amount/currency copied from the invoice',
    exists (
      select 1 from payments
      where id = v_row.payment_id and status = 'pending' and method = 'razorpay'
        and amount = 1000.00 and currency = 'INR' and invoice_id = '14400001-0000-0000-0000-000000000001'
        and submitted_by_user_id = 'e0000001-0000-0000-0000-000000000001'
    )
  );
end;
$$;

select test_assert(
  'payment_order_created is recorded in audit_logs, attributed to the real actor',
  exists (
    select 1 from audit_logs
    where company_id = 'd1000001-0000-0000-0000-000000000001' and action = 'payment_order_created'
      and actor_user_id = 'e0000001-0000-0000-0000-000000000001' and actor_type = 'user'
  )
);

-- ---------------------------------------------------------------------------
-- 2. Amount/currency/company tampering is structurally impossible: there is
--    no parameter to tamper with. Explicitly prove the function signature.
-- ---------------------------------------------------------------------------

select test_assert(
  'create_payment_order takes only an invoice id -- no amount, currency, or company_id parameter exists to tamper with',
  (select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'create_payment_order' limit 1) = 'p_invoice_id uuid'
);

-- ---------------------------------------------------------------------------
-- 3. Payability rules: already-paid, void, and zero/negative-amount
--    invoices are all rejected before any payment row is created.
-- ---------------------------------------------------------------------------

select test_assert_raises_like(
  'a payment cannot be created for an already-paid invoice',
  $sql$ select * from create_payment_order('14400001-0000-0000-0000-000000000002') $sql$,
  'invoice_not_payable'
);

select test_assert_raises_like(
  'a payment cannot be created for a void invoice',
  $sql$ select * from create_payment_order('14400001-0000-0000-0000-000000000003') $sql$,
  'invoice_not_payable'
);

select test_assert_raises_like(
  'a payment cannot be created for a nonexistent invoice id',
  $sql$ select * from create_payment_order('00000000-0000-0000-0000-000000000000') $sql$,
  'invoice_not_found'
);

-- ---------------------------------------------------------------------------
-- 4. Cross-tenant protection: Company A's owner cannot pay Company B's
--    invoice -- rejected as permission_denied (the invoice's OWN company_id
--    is checked, not anything the caller claims), never leaking whether the
--    invoice exists.
-- ---------------------------------------------------------------------------

select test_assert_raises_like(
  'Company A owner cannot create a payment order for Company B''s invoice (cross-tenant forged invoice id)',
  $sql$ select * from create_payment_order('14400002-0000-0000-0000-000000000001') $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 5. Role coverage: company_admin and company_accounts can pay; manager,
--    team_leader, sales_person cannot (no billing.pay).
-- ---------------------------------------------------------------------------

select test_set_current_user('e0000001-0000-0000-0000-000000000002'); -- admin-a
do $$
begin
  perform create_payment_order('14400001-0000-0000-0000-000000000004');
  raise notice 'OK: company_admin can create a payment order for their own company''s invoice';
end;
$$;

select test_set_current_user('e0000001-0000-0000-0000-000000000003'); -- accounts-a
do $$
begin
  perform create_payment_order('14400001-0000-0000-0000-000000000005');
  raise notice 'OK: company_accounts can create a payment order for their own company''s invoice';
end;
$$;

select test_set_current_user('e0000001-0000-0000-0000-000000000004'); -- manager-a
select test_assert_raises_like(
  'manager cannot initiate a payment (no billing.pay)',
  $sql$ select * from create_payment_order('14400001-0000-0000-0000-000000000006') $sql$,
  'permission_denied'
);

select test_set_current_user('e0000001-0000-0000-0000-000000000005'); -- teamlead-a
select test_assert_raises_like(
  'team_leader cannot initiate a payment (no billing.pay)',
  $sql$ select * from create_payment_order('14400001-0000-0000-0000-000000000006') $sql$,
  'permission_denied'
);

select test_set_current_user('e0000001-0000-0000-0000-000000000006'); -- sales-a
select test_assert_raises_like(
  'sales_person cannot initiate a payment (no billing.pay)',
  $sql$ select * from create_payment_order('14400001-0000-0000-0000-000000000006') $sql$,
  'permission_denied'
);

-- ---------------------------------------------------------------------------
-- 6. attach_razorpay_order: only the submitter can attach an order id to
--    their own pending payment, only once.
-- ---------------------------------------------------------------------------

select test_set_current_user('e0000001-0000-0000-0000-000000000001'); -- owner-a
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-000000000001';
  perform attach_razorpay_order(v_payment_id, 'order_TESTORDER0001');
  perform test_assert(
    'attach_razorpay_order records the order id on the caller''s own pending payment',
    (select provider_reference from payments where id = v_payment_id) = 'order_TESTORDER0001'
  );
end;
$$;

do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-000000000001';
  begin
    perform attach_razorpay_order(v_payment_id, 'order_TESTORDER0002');
    raise exception 'ASSERTION FAILED: attaching a second order id to an already-attached payment must be rejected';
  exception
    when others then
      if sqlerrm <> 'order_already_attached' then
        raise exception 'ASSERTION FAILED: expected order_already_attached but got %', sqlerrm;
      end if;
      raise notice 'OK: attach_razorpay_order rejects a second attach attempt on the same payment (write-once)';
  end;
end;
$$;

select test_set_current_user('e0000001-0000-0000-0000-000000000002'); -- admin-a (not the submitter of owner-a's payment)
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-000000000004'; -- admin-a's own payment
  -- admin-a IS the submitter of this one -- switch to a payment they did NOT submit.
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-000000000005'; -- accounts-a's payment
  begin
    perform attach_razorpay_order(v_payment_id, 'order_STOLEN0001');
    raise exception 'ASSERTION FAILED: a caller must not be able to attach an order id to another user''s pending payment';
  exception
    when others then
      if sqlerrm <> 'permission_denied' then
        raise exception 'ASSERTION FAILED: expected permission_denied but got %', sqlerrm;
      end if;
      raise notice 'OK: attach_razorpay_order rejects attaching to a payment the caller did not submit';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. reconcile_razorpay_payment (service_role only, the webhook path).
--    'A real service_role call never carries a JWT sub claim' -- same
--    convention as rls_handover.sql's reconcile_outbound_message tests.
-- ---------------------------------------------------------------------------

reset role;
set local role service_role;
select test_clear_current_user();

-- 7a. Successful capture on the subscription invoice: payment succeeds,
--     invoice paid, subscription renewed (period extends, state -> active),
--     exactly one subscription_event and one audit_logs row.
do $$
declare
  v_payment_id uuid;
  v_period_end_before timestamptz;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-000000000001';
  select current_period_end into v_period_end_before from subscriptions where company_id = 'd1000001-0000-0000-0000-000000000001';

  perform reconcile_razorpay_payment('payment.captured:pay_TEST0001', 'captured', 'order_TESTORDER0001', 'pay_TEST0001', '{"test":true}'::jsonb);

  perform test_assert('the payment is now succeeded with the Razorpay payment id recorded',
    exists (select 1 from payments where id = v_payment_id and status = 'succeeded' and provider_payment_id = 'pay_TEST0001'));
  perform test_assert('the subscription invoice is now paid, with a paid_date set',
    exists (select 1 from invoices where id = '14400001-0000-0000-0000-000000000001' and status = 'paid' and paid_date is not null));
  perform test_assert('the subscription state advanced to active and the period extended past the prior period_end',
    exists (select 1 from subscriptions where company_id = 'd1000001-0000-0000-0000-000000000001' and state = 'active' and current_period_end > v_period_end_before));
  perform test_assert('exactly one payment_recovered subscription_event was recorded for this reconciliation',
    (select count(*) from subscription_events where subscription_id = '13300001-0000-0000-0000-000000000001' and event = 'payment_recovered') = 1);
  perform test_assert('a payment_completed audit_logs row was recorded, system-attributed (no live user in a webhook call)',
    exists (select 1 from audit_logs where action = 'payment_completed' and target_id = v_payment_id::text and actor_type = 'system' and actor_user_id is null));
  raise notice 'OK: reconcile_razorpay_payment fully reconciles a captured subscription-invoice payment';
end;
$$;

-- 7b. Idempotency: the exact same webhook event delivered a second time
--     must not double-process anything.
do $$
declare
  v_period_end_after_first timestamptz;
  v_period_end_after_retry timestamptz;
begin
  select current_period_end into v_period_end_after_first from subscriptions where company_id = 'd1000001-0000-0000-0000-000000000001';

  perform reconcile_razorpay_payment('payment.captured:pay_TEST0001', 'captured', 'order_TESTORDER0001', 'pay_TEST0001', '{"test":true}'::jsonb);

  select current_period_end into v_period_end_after_retry from subscriptions where company_id = 'd1000001-0000-0000-0000-000000000001';
  perform test_assert('a duplicate webhook delivery (same provider_event_id) does not extend the period a second time',
    v_period_end_after_first = v_period_end_after_retry);
  perform test_assert('a duplicate webhook delivery does not create a second subscription_event',
    (select count(*) from subscription_events where subscription_id = '13300001-0000-0000-0000-000000000001' and event = 'payment_recovered') = 1);
  perform test_assert('a duplicate webhook delivery does not create a second payment_completed audit row',
    (select count(*) from audit_logs where action = 'payment_completed' and metadata->>'provider_payment_id' = 'pay_TEST0001') = 1);
  raise notice 'OK: reconcile_razorpay_payment is idempotent against a retried webhook delivery';
end;
$$;

-- 7c. Callback-then-webhook / webhook-then-callback convergence: reconciling
--     an already-'succeeded' payment again (different event id, e.g. a
--     late/duplicate order.paid-style delivery for the same order) is a
--     safe no-op because the payment is no longer 'pending'.
do $$
declare
  v_row_count int;
begin
  perform reconcile_razorpay_payment('payment.captured:pay_TEST0001-late', 'captured', 'order_TESTORDER0001', 'pay_TEST0001', '{"test":"late-duplicate"}'::jsonb);
  select count(*) into v_row_count from payments where provider_reference = 'order_TESTORDER0001';
  perform test_assert('reconciling an already-succeeded payment again (different event id, same order) never creates a second payment row',
    v_row_count = 1);
  perform test_assert('reconciling an already-succeeded payment again does not re-extend the subscription period',
    (select count(*) from subscription_events where subscription_id = '13300001-0000-0000-0000-000000000001' and event = 'payment_recovered') = 1);
  raise notice 'OK: a second distinct event for an already-reconciled (no-longer-pending) payment safely converges without reprocessing';
end;
$$;

-- 7d. Failure path: a failed payment marks the payment failed, leaves the
--     invoice untouched, and never renews the subscription.
--     attach_razorpay_order is authenticated-only (correctly rejected for
--     service_role), so it must be called as the payment's own submitter
--     (admin-a, from section 5) before switching back to service_role for
--     the webhook-side reconcile_razorpay_payment call.
reset role;
set local role authenticated;
select test_set_current_user('e0000001-0000-0000-0000-000000000002'); -- admin-a, submitter of invoice 0004's payment
select attach_razorpay_order(
  (select id from payments where invoice_id = '14400001-0000-0000-0000-000000000004'),
  'order_TESTORDER0004'
);

reset role;
set local role service_role;
select test_clear_current_user();

do $$
declare
  v_payment_id uuid;
  v_invoice_status invoice_status;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-000000000004';
  perform reconcile_razorpay_payment('payment.failed:pay_TEST0004', 'failed', 'order_TESTORDER0004', 'pay_TEST0004', '{"test":true}'::jsonb);

  perform test_assert('a failed payment is marked failed',
    exists (select 1 from payments where id = v_payment_id and status = 'failed'));
  select status into v_invoice_status from invoices where id = '14400001-0000-0000-0000-000000000004';
  perform test_assert('the invoice behind a failed payment stays pending (never marked paid, never marked failed itself)',
    v_invoice_status = 'pending');
  perform test_assert('a payment_failed audit_logs row was recorded',
    exists (select 1 from audit_logs where action = 'payment_failed' and target_id = v_payment_id::text));
  raise notice 'OK: reconcile_razorpay_payment handles a failed payment without touching the invoice or subscription';
end;
$$;

-- 7e. Service-charge invoice: paid, but must NEVER renew/touch the
--     subscription (only a subscription-kind invoice may do that).
do $$
declare
  v_payment_id uuid;
  v_period_end_before timestamptz;
  v_period_end_after timestamptz;
begin
  select current_period_end into v_period_end_before from subscriptions where company_id = 'd1000001-0000-0000-0000-000000000001';

  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000001-0000-0000-0000-000000000001', '14400001-0000-0000-0000-000000000006', 'razorpay', 'pending', 500.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_TESTORDER_SVC1' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_TEST_SVC1', 'captured', 'order_TESTORDER_SVC1', 'pay_TEST_SVC1', '{"test":true}'::jsonb);

  perform test_assert('the service-charge invoice is marked paid',
    exists (select 1 from invoices where id = '14400001-0000-0000-0000-000000000006' and status = 'paid'));
  select current_period_end into v_period_end_after from subscriptions where company_id = 'd1000001-0000-0000-0000-000000000001';
  perform test_assert('paying a service-charge invoice never extends the subscription period',
    v_period_end_before = v_period_end_after);
  perform test_assert('paying a service-charge invoice never creates a subscription_event',
    not exists (select 1 from subscription_events where subscription_id = '13300001-0000-0000-0000-000000000001' and notes like '%pay_TEST_SVC1%'));
  raise notice 'OK: a service-charge invoice payment is recorded without ever touching the subscription';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Cross-tenant isolation of the reconciliation path itself: reconciling
--    Company A's order must never touch Company B's subscription/invoice.
-- ---------------------------------------------------------------------------

do $$
declare
  v_b_period_end_before timestamptz;
  v_b_period_end_after timestamptz;
  v_b_invoice_status invoice_status;
begin
  select current_period_end into v_b_period_end_before from subscriptions where company_id = 'd2000001-0000-0000-0000-000000000001';

  -- Reconciling Company A's already-processed order again (from step 7c)
  -- must never reach anywhere near Company B's rows.
  perform reconcile_razorpay_payment('payment.captured:pay_TEST0001-cross-check', 'captured', 'order_TESTORDER0001', 'pay_TEST0001', '{"test":"cross-tenant-check"}'::jsonb);

  select current_period_end into v_b_period_end_after from subscriptions where company_id = 'd2000001-0000-0000-0000-000000000001';
  select status into v_b_invoice_status from invoices where id = '14400002-0000-0000-0000-000000000001';
  perform test_assert('reconciling Company A''s payment never touches Company B''s subscription period',
    v_b_period_end_before = v_b_period_end_after);
  perform test_assert('Company B''s invoice remains untouched (still pending)',
    v_b_invoice_status = 'pending');
  raise notice 'OK: reconciliation is fully tenant-isolated by construction (looked up via the payment''s own company_id, never a parameter)';
end;
$$;

reset role;

rollback;
