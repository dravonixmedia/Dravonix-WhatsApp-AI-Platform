-- Phase 6B: Razorpay Orders + Checkout payment capability (migration 28)
-- RLS/RPC hardening tests. Run after rls_support_requests.sql (via
-- supabase/tests/run.sh), against the same throwaway local Postgres
-- database -- never a hosted Supabase project. No real Razorpay API call
-- is made anywhere in this file: create_payment_order/attach_razorpay_order
-- are tested up to (and including) the DB-side pending-payment/order-id
-- steps; reconcile_razorpay_payment is tested directly, as the webhook
-- handler in apps/api would call it, with fabricated order/payment ids.
--
-- Also covers the post-review corrections: payments.provider_reference
-- cross-row/cross-company uniqueness, a failed attempt never blocking a
-- later real capture on the same order (nor a late failed notification
-- ever downgrading an already-succeeded payment), webhook-reported amount/
-- currency verification against the internal payment record, and the
-- approved late-payment subscription renewal timing rule.

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
-- payments.provider_reference must be protected by a real database-level
-- uniqueness constraint, not merely an application-level check.
-- ---------------------------------------------------------------------------

select test_assert(
  'payments.provider_reference has a unique constraint (payments_provider_reference_key)',
  exists (
    select 1 from pg_constraint
    where conrelid = 'payments'::regclass
      and contype = 'u'
      and conkey = (
        select array_agg(attnum) from pg_attribute
        where attrelid = 'payments'::regclass and attname = 'provider_reference'
      )
  )
);

select test_assert(
  'reconcile_razorpay_payment locks the matched payment row with FOR UPDATE (row locking, not the status check alone, is what makes two concurrent reconciliation attempts for the same order serialize safely -- a true concurrent-connections test is outside what this single-session psql harness can exercise, but the locking clause itself is verified directly here)',
  pg_get_functiondef((select oid from pg_proc where proname = 'reconcile_razorpay_payment' limit 1)) ilike '%for update%'
);

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- Company A: owner, admin, accounts, manager, team_leader, sales_person --
-- one subscription (kind-agnostic; invoices below carry their own kind) and
-- invoices covering payability rules, role coverage, order-uniqueness, and
-- amount/currency verification (the latter two groups deliberately
-- service_charge so they never interact with Company A's own subscription
-- renewal, which is exercised separately in section 7).
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
  ('14400001-0000-0000-0000-000000000007', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0007', 'pending', 'INR', 200.00),
  ('14400001-0000-0000-0000-000000000008', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0008', 'pending', 'INR', 200.00),
  ('14400001-0000-0000-0000-000000000009', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0009', 'pending', 'INR', 1500.00),
  ('14400001-0000-0000-0000-00000000000a', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-000A', 'pending', 'INR', 1500.00),
  ('14400001-0000-0000-0000-00000000000b', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-000B', 'pending', 'INR', 999.50),
  ('14400001-0000-0000-0000-00000000000c', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-000C', 'pending', 'INR', 1500.00),
  ('14400001-0000-0000-0000-00000000000d', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-000D', 'pending', 'INR', 1500.00),
  ('14400001-0000-0000-0000-00000000000e', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-000E', 'pending', 'INR', 1500.00),
  ('14400001-0000-0000-0000-00000000000f', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-000F', 'pending', 'INR', 999999.99),
  ('14400001-0000-0000-0000-000000000010', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0010', 'pending', 'INR', 1500.00),
  ('14400001-0000-0000-0000-000000000011', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0011', 'pending', 'INR', 1500.00),
  ('14400001-0000-0000-0000-000000000012', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0012', 'pending', 'INR', 1500.00),
  ('14400001-0000-0000-0000-000000000013', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0013', 'pending', 'INR', 1500.00),
  ('14400001-0000-0000-0000-000000000014', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0014', 'pending', 'INR', 750.00),
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
-- 6a. Order-id uniqueness ACROSS rows (payments_provider_reference_key):
--     the same Razorpay order id can never be attached to a second payment
--     row, whether that row belongs to the same company or a different one.
-- ---------------------------------------------------------------------------

select test_set_current_user('e0000001-0000-0000-0000-000000000001'); -- owner-a
do $$
declare
  v_p1 uuid;
  v_p2 uuid;
begin
  select payment_id into v_p1 from create_payment_order('14400001-0000-0000-0000-000000000007');
  select payment_id into v_p2 from create_payment_order('14400001-0000-0000-0000-000000000008');

  perform attach_razorpay_order(v_p1, 'order_DUPTEST0001');
  perform test_assert('normal attachment succeeds on a fresh pending payment',
    (select provider_reference from payments where id = v_p1) = 'order_DUPTEST0001');

  begin
    perform attach_razorpay_order(v_p2, 'order_DUPTEST0001');
    raise exception 'ASSERTION FAILED: the same order id must not be attachable to a second payment row in the same company';
  exception
    when others then
      if sqlerrm <> 'order_already_attached' then
        raise exception 'ASSERTION FAILED: expected order_already_attached but got %', sqlerrm;
      end if;
      raise notice 'OK: attach_razorpay_order rejects attaching an already-used order id to a second payment row (same company)';
  end;

  perform test_assert('the second payment row was never given the order id (still unattached after the rejected attempt)',
    (select provider_reference from payments where id = v_p2) is null);
end;
$$;

select test_set_current_user('e0000002-0000-0000-0000-000000000001'); -- owner-b
do $$
declare
  v_pb uuid;
begin
  select payment_id into v_pb from create_payment_order('14400002-0000-0000-0000-000000000001');
  begin
    perform attach_razorpay_order(v_pb, 'order_DUPTEST0001'); -- already owned by Company A's payment
    raise exception 'ASSERTION FAILED: a Company B payment must not be attachable to an order id Company A already owns';
  exception
    when others then
      if sqlerrm <> 'order_already_attached' then
        raise exception 'ASSERTION FAILED: expected order_already_attached but got %', sqlerrm;
      end if;
      raise notice 'OK: attach_razorpay_order rejects an already-used order id across companies, not just within one';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6b. Attach the payments used by the amount/currency verification tests in
--     section 11, while still authenticated -- exercising the real
--     create_payment_order + attach_razorpay_order flow exactly as
--     production would, before switching to service_role for reconciliation.
-- ---------------------------------------------------------------------------

select test_set_current_user('e0000001-0000-0000-0000-000000000001'); -- owner-a
do $$
declare
  v_payment_id uuid;
begin
  select payment_id into v_payment_id from create_payment_order('14400001-0000-0000-0000-000000000009');
  perform attach_razorpay_order(v_payment_id, 'order_AMOUNTCHK0009');

  select payment_id into v_payment_id from create_payment_order('14400001-0000-0000-0000-00000000000a');
  perform attach_razorpay_order(v_payment_id, 'order_AMOUNTCHK000A');

  select payment_id into v_payment_id from create_payment_order('14400001-0000-0000-0000-00000000000b');
  perform attach_razorpay_order(v_payment_id, 'order_AMOUNTCHK000B');

  select payment_id into v_payment_id from create_payment_order('14400001-0000-0000-0000-00000000000c');
  perform attach_razorpay_order(v_payment_id, 'order_AMOUNTCHK000C');

  select payment_id into v_payment_id from create_payment_order('14400001-0000-0000-0000-00000000000d');
  perform attach_razorpay_order(v_payment_id, 'order_AMOUNTCHK000D');

  select payment_id into v_payment_id from create_payment_order('14400001-0000-0000-0000-00000000000e');
  perform attach_razorpay_order(v_payment_id, 'order_AMOUNTCHK000E');

  select payment_id into v_payment_id from create_payment_order('14400001-0000-0000-0000-00000000000f');
  perform attach_razorpay_order(v_payment_id, 'order_AMOUNTCHK000F');

  select payment_id into v_payment_id from create_payment_order('14400001-0000-0000-0000-000000000010');
  perform attach_razorpay_order(v_payment_id, 'order_AMOUNTCHK0010');

  raise notice 'OK: all amount/currency-verification test payments created and attached';
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

  perform reconcile_razorpay_payment('payment.captured:pay_TEST0001', 'captured', 'order_TESTORDER0001', 'pay_TEST0001', 100000, 'INR', '{"test":true}'::jsonb);

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

  perform reconcile_razorpay_payment('payment.captured:pay_TEST0001', 'captured', 'order_TESTORDER0001', 'pay_TEST0001', 100000, 'INR', '{"test":true}'::jsonb);

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
--     safe no-op because the payment has already reached the one terminal
--     state, 'succeeded'.
do $$
declare
  v_row_count int;
begin
  perform reconcile_razorpay_payment('payment.captured:pay_TEST0001-late', 'captured', 'order_TESTORDER0001', 'pay_TEST0001', 100000, 'INR', '{"test":"late-duplicate"}'::jsonb);
  select count(*) into v_row_count from payments where provider_reference = 'order_TESTORDER0001';
  perform test_assert('reconciling an already-succeeded payment again (different event id, same order) never creates a second payment row',
    v_row_count = 1);
  perform test_assert('reconciling an already-succeeded payment again does not re-extend the subscription period',
    (select count(*) from subscription_events where subscription_id = '13300001-0000-0000-0000-000000000001' and event = 'payment_recovered') = 1);
  raise notice 'OK: a second distinct event for an already-reconciled (succeeded) payment safely converges without reprocessing';
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
  perform reconcile_razorpay_payment('payment.failed:pay_TEST0004', 'failed', 'order_TESTORDER0004', 'pay_TEST0004', 100000, 'INR', '{"test":true}'::jsonb);

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

  perform reconcile_razorpay_payment('payment.captured:pay_TEST_SVC1', 'captured', 'order_TESTORDER_SVC1', 'pay_TEST_SVC1', 50000, 'INR', '{"test":true}'::jsonb);

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
  perform reconcile_razorpay_payment('payment.captured:pay_TEST0001-cross-check', 'captured', 'order_TESTORDER0001', 'pay_TEST0001', 100000, 'INR', '{"test":"cross-tenant-check"}'::jsonb);

  select current_period_end into v_b_period_end_after from subscriptions where company_id = 'd2000001-0000-0000-0000-000000000001';
  select status into v_b_invoice_status from invoices where id = '14400002-0000-0000-0000-000000000001';
  perform test_assert('reconciling Company A''s payment never touches Company B''s subscription period',
    v_b_period_end_before = v_b_period_end_after);
  perform test_assert('Company B''s invoice remains untouched (still pending)',
    v_b_invoice_status = 'pending');
  raise notice 'OK: reconciliation is fully tenant-isolated by construction (looked up via the payment''s own company_id, never a parameter)';
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Subscription renewal timing (approved DRAIVA billing rule): paying
--    before the current period ends preserves continuous billing; paying
--    after it has lapsed (or when no period has ever existed) grants a
--    fresh full period starting from reconciliation time. Every fixture
--    below sets its current_period_end relative to now() itself, and every
--    assertion compares against now() again -- both evaluate to the exact
--    same value because this whole test file runs inside one transaction
--    (now() is transaction-stable in Postgres), so these are exact
--    equality checks, not fuzzy time-window tolerances.
-- ---------------------------------------------------------------------------

insert into companies (id, name, slug, status, is_demo) values
  ('d3000001-0000-0000-0000-000000000001', 'Pay Co C (early)', 'pay-co-c', 'active', true),
  ('d4000001-0000-0000-0000-000000000001', 'Pay Co D (late, active)', 'pay-co-d', 'active', true),
  ('d5000001-0000-0000-0000-000000000001', 'Pay Co E (late, payment_due)', 'pay-co-e', 'active', true),
  ('d6000001-0000-0000-0000-000000000001', 'Pay Co F (late, grace_period)', 'pay-co-f', 'active', true),
  ('d7000001-0000-0000-0000-000000000001', 'Pay Co G (late, suspended)', 'pay-co-g', 'active', true),
  ('d8000001-0000-0000-0000-000000000001', 'Pay Co H (null period)', 'pay-co-h', 'active', true),
  ('d9000001-0000-0000-0000-000000000001', 'Pay Co I (cancelled)', 'pay-co-i', 'active', true);

insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end, grace_period_end) values
  ('13300003-0000-0000-0000-000000000001', 'd3000001-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'active', now() - interval '20 days', now() + interval '10 days', null),
  ('13300004-0000-0000-0000-000000000001', 'd4000001-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'active', now() - interval '40 days', now() - interval '10 days', null),
  ('13300005-0000-0000-0000-000000000001', 'd5000001-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'payment_due', now() - interval '40 days', now() - interval '10 days', null),
  ('13300006-0000-0000-0000-000000000001', 'd6000001-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'grace_period', now() - interval '40 days', now() - interval '10 days', now() - interval '3 days'),
  ('13300007-0000-0000-0000-000000000001', 'd7000001-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'suspended', now() - interval '60 days', now() - interval '25 days', null),
  ('13300008-0000-0000-0000-000000000001', 'd8000001-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'payment_due', null, null, null),
  ('13300009-0000-0000-0000-000000000001', 'd9000001-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'cancelled', now() - interval '60 days', now() - interval '25 days', null);

insert into invoices (id, company_id, kind, invoice_number, status, currency, total) values
  ('14400003-0000-0000-0000-000000000001', 'd3000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-C-0001', 'pending', 'INR', 1000.00),
  ('14400004-0000-0000-0000-000000000001', 'd4000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-D-0001', 'pending', 'INR', 1000.00),
  ('14400005-0000-0000-0000-000000000001', 'd5000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-E-0001', 'pending', 'INR', 1000.00),
  ('14400006-0000-0000-0000-000000000001', 'd6000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-F-0001', 'pending', 'INR', 1000.00),
  ('14400007-0000-0000-0000-000000000001', 'd7000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-G-0001', 'pending', 'INR', 1000.00),
  ('14400008-0000-0000-0000-000000000001', 'd8000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-H-0001', 'pending', 'INR', 1000.00),
  ('14400009-0000-0000-0000-000000000001', 'd9000001-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-I-0001', 'pending', 'INR', 1000.00);

-- 9a. active + early payment (before current_period_end): the new period
--     starts exactly where the old one ended -- continuous billing.
do $$
declare
  v_payment_id uuid;
  v_old_period_end timestamptz;
begin
  select current_period_end into v_old_period_end from subscriptions where company_id = 'd3000001-0000-0000-0000-000000000001';

  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d3000001-0000-0000-0000-000000000001', '14400003-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RENEWAL_C0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_RENEWAL_C0001', 'captured', 'order_RENEWAL_C0001', 'pay_RENEWAL_C0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('active + early payment: the new period starts exactly at the old current_period_end (continuous billing)',
    (select current_period_start from subscriptions where company_id = 'd3000001-0000-0000-0000-000000000001') = v_old_period_end);
  perform test_assert('active + early payment: the new period end is exactly one month after the new start',
    (select current_period_end from subscriptions where company_id = 'd3000001-0000-0000-0000-000000000001') = v_old_period_end + interval '1 month');
  perform test_assert('active + early payment: exactly one subscription_event was recorded',
    (select count(*) from subscription_events where subscription_id = '13300003-0000-0000-0000-000000000001') = 1);
  raise notice 'OK: an early payment on an active subscription preserves continuous billing';
end;
$$;

-- 9b. active + late payment (after current_period_end has already lapsed):
--     the new period starts fresh from reconciliation time (now()), never
--     from the stale, already-past current_period_end.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d4000001-0000-0000-0000-000000000001', '14400004-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RENEWAL_D0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_RENEWAL_D0001', 'captured', 'order_RENEWAL_D0001', 'pay_RENEWAL_D0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('active + late payment: the new period starts now(), not the stale expired current_period_end',
    (select current_period_start from subscriptions where company_id = 'd4000001-0000-0000-0000-000000000001') = now());
  perform test_assert('active + late payment: the new period end is exactly one month from now()',
    (select current_period_end from subscriptions where company_id = 'd4000001-0000-0000-0000-000000000001') = now() + interval '1 month');
  perform test_assert('active + late payment: the subscription state is active',
    (select state from subscriptions where company_id = 'd4000001-0000-0000-0000-000000000001') = 'active');
  raise notice 'OK: a late payment on an active subscription starts a fresh full period from reconciliation time, never in the past';
end;
$$;

-- 9c. payment_due + expired period: same fresh-period-from-now rule.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d5000001-0000-0000-0000-000000000001', '14400005-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RENEWAL_E0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_RENEWAL_E0001', 'captured', 'order_RENEWAL_E0001', 'pay_RENEWAL_E0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('payment_due + expired period: new period starts now(), state advances to active',
    (select current_period_start = now() and state = 'active' from subscriptions where company_id = 'd5000001-0000-0000-0000-000000000001'));
  raise notice 'OK: a late payment recovers a payment_due subscription with a fresh period from now()';
end;
$$;

-- 9d. grace_period + expired period: fresh period from now(), and
--     grace_period_end is cleared.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d6000001-0000-0000-0000-000000000001', '14400006-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RENEWAL_F0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_RENEWAL_F0001', 'captured', 'order_RENEWAL_F0001', 'pay_RENEWAL_F0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('grace_period + expired period: new period starts now(), state advances to active, grace_period_end cleared',
    (select current_period_start = now() and state = 'active' and grace_period_end is null
     from subscriptions where company_id = 'd6000001-0000-0000-0000-000000000001'));
  raise notice 'OK: a late payment recovers a grace_period subscription and clears its grace_period_end';
end;
$$;

-- 9e. suspended + expired period: same fresh-period-from-now rule.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d7000001-0000-0000-0000-000000000001', '14400007-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RENEWAL_G0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_RENEWAL_G0001', 'captured', 'order_RENEWAL_G0001', 'pay_RENEWAL_G0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('suspended + expired period: new period starts now(), state advances to active',
    (select current_period_start = now() and state = 'active' from subscriptions where company_id = 'd7000001-0000-0000-0000-000000000001'));
  raise notice 'OK: a late payment recovers a suspended subscription with a fresh period from now()';
end;
$$;

-- 9f. NULL current_period_end (never had a period): starts fresh from now().
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d8000001-0000-0000-0000-000000000001', '14400008-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RENEWAL_H0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_RENEWAL_H0001', 'captured', 'order_RENEWAL_H0001', 'pay_RENEWAL_H0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('a subscription that never had a period starts its first period at now(), not any earlier date',
    (select current_period_start = now() and current_period_end = now() + interval '1 month'
     from subscriptions where company_id = 'd8000001-0000-0000-0000-000000000001'));
  raise notice 'OK: a subscription with no prior period gets a fresh period starting from reconciliation time';
end;
$$;

-- 9g. cancelled: never reactivated by a stray payment. The invoice behind
--     it is still marked paid (the money was genuinely received), but the
--     cancelled subscription itself, its period, and its event history are
--     completely untouched.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d9000001-0000-0000-0000-000000000001', '14400009-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RENEWAL_I0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_RENEWAL_I0001', 'captured', 'order_RENEWAL_I0001', 'pay_RENEWAL_I0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('a cancelled subscription''s invoice can still be marked paid',
    exists (select 1 from invoices where id = '14400009-0000-0000-0000-000000000001' and status = 'paid'));
  perform test_assert('a cancelled subscription is never reactivated or renewed by a stray payment',
    (select state = 'cancelled' and current_period_start = (now() - interval '60 days') and current_period_end = (now() - interval '25 days')
     from subscriptions where company_id = 'd9000001-0000-0000-0000-000000000001'));
  perform test_assert('a cancelled subscription gets no subscription_event from a stray payment',
    not exists (select 1 from subscription_events where subscription_id = '13300009-0000-0000-0000-000000000001'));
  raise notice 'OK: paying a cancelled subscription''s invoice never reactivates or renews the subscription';
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Failed/captured convergence for repeated attempts against the same
--     Razorpay order (Company A, service_charge invoices so subscription
--     state is never a variable in these assertions).
-- ---------------------------------------------------------------------------

-- 10a. failed -> captured: a real successful retry after one declined
--      attempt must still succeed (never permanently blocked by the
--      earlier failure).
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000001-0000-0000-0000-000000000001', '14400001-0000-0000-0000-000000000011', 'razorpay', 'pending', 1500.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RETRY_J0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.failed:pay_RETRY_J1', 'failed', 'order_RETRY_J0001', 'pay_RETRY_J1', 150000, 'INR', '{}'::jsonb);
  perform test_assert('the first, declined attempt marks the payment failed', (select status from payments where id = v_payment_id) = 'failed');

  perform reconcile_razorpay_payment('payment.captured:pay_RETRY_J2', 'captured', 'order_RETRY_J0001', 'pay_RETRY_J2', 150000, 'INR', '{}'::jsonb);
  perform test_assert('a later, genuinely successful retry against the same order still succeeds',
    (select status from payments where id = v_payment_id) = 'succeeded' and (select provider_payment_id from payments where id = v_payment_id) = 'pay_RETRY_J2');
  perform test_assert('the invoice behind the retried order is marked paid',
    exists (select 1 from invoices where id = '14400001-0000-0000-0000-000000000011' and status = 'paid'));
  raise notice 'OK: a failed attempt never permanently blocks a later real capture on the same order';
end;
$$;

-- 10b. failed -> failed -> captured: two declined attempts, then a real
--      success, still converges to exactly one successful reconciliation.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000001-0000-0000-0000-000000000001', '14400001-0000-0000-0000-000000000012', 'razorpay', 'pending', 1500.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RETRY_K0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.failed:pay_RETRY_K1', 'failed', 'order_RETRY_K0001', 'pay_RETRY_K1', 150000, 'INR', '{}'::jsonb);
  perform reconcile_razorpay_payment('payment.failed:pay_RETRY_K2', 'failed', 'order_RETRY_K0001', 'pay_RETRY_K2', 150000, 'INR', '{}'::jsonb);
  perform test_assert('two consecutive declined attempts both record independently (still not terminal)',
    (select status from payments where id = v_payment_id) = 'failed');

  perform reconcile_razorpay_payment('payment.captured:pay_RETRY_K3', 'captured', 'order_RETRY_K0001', 'pay_RETRY_K3', 150000, 'INR', '{}'::jsonb);
  perform test_assert('a third, successful attempt after two failures still succeeds',
    (select status from payments where id = v_payment_id) = 'succeeded' and (select provider_payment_id from payments where id = v_payment_id) = 'pay_RETRY_K3');
  perform test_assert('exactly one payment_completed audit row exists for this payment despite the two prior failures',
    (select count(*) from audit_logs where action = 'payment_completed' and target_id = v_payment_id::text) = 1);
  perform test_assert('exactly two payment_failed audit rows exist, one per genuinely distinct declined attempt',
    (select count(*) from audit_logs where action = 'payment_failed' and target_id = v_payment_id::text) = 2);
  raise notice 'OK: multiple failed attempts followed by a capture converge to exactly one successful reconciliation';
end;
$$;

-- 10c. captured -> (duplicate captured) -> failed: a succeeded payment must
--      never be downgraded by a late/out-of-order failed notification.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000001-0000-0000-0000-000000000001', '14400001-0000-0000-0000-000000000013', 'razorpay', 'pending', 1500.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_RETRY_L0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_RETRY_L1', 'captured', 'order_RETRY_L0001', 'pay_RETRY_L1', 150000, 'INR', '{}'::jsonb);
  perform test_assert('the payment succeeds on first capture', (select status from payments where id = v_payment_id) = 'succeeded');

  -- Exact duplicate delivery of the same captured event.
  perform reconcile_razorpay_payment('payment.captured:pay_RETRY_L1', 'captured', 'order_RETRY_L0001', 'pay_RETRY_L1', 150000, 'INR', '{}'::jsonb);
  perform test_assert('a duplicate delivery of the same captured event remains succeeded',
    (select status from payments where id = v_payment_id) = 'succeeded');

  -- A late/out-of-order failed notification for a different (earlier) attempt id.
  perform reconcile_razorpay_payment('payment.failed:pay_RETRY_L0', 'failed', 'order_RETRY_L0001', 'pay_RETRY_L0', 150000, 'INR', '{}'::jsonb);
  perform test_assert('a late failed notification never downgrades an already-succeeded payment',
    (select status from payments where id = v_payment_id) = 'succeeded' and (select provider_payment_id from payments where id = v_payment_id) = 'pay_RETRY_L1');
  raise notice 'OK: captured -> duplicate captured -> failed converges to SUCCEEDED, never downgraded';
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Amount/currency verification: the webhook's reported amount/currency
--     must match the internal payment's own amount/currency before a
--     captured payment is ever marked succeeded. Uses the payments created
--     and attached in section 6b.
-- ---------------------------------------------------------------------------

-- 11a. Wrong amount: rejected, payment stays pending, invoice stays
--      unpaid, no payment_completed, a payment_amount_mismatch audit row
--      is recorded for investigation.
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-000000000009';
  perform reconcile_razorpay_payment('payment.captured:pay_AMT_0009', 'captured', 'order_AMOUNTCHK0009', 'pay_AMT_0009', 100000, 'INR', '{}'::jsonb);

  perform test_assert('a captured event reporting the wrong amount is rejected -- payment stays pending',
    (select status from payments where id = v_payment_id) = 'pending');
  perform test_assert('the invoice behind a wrong-amount capture stays unpaid',
    (select status from invoices where id = '14400001-0000-0000-0000-000000000009') = 'pending');
  perform test_assert('no payment_completed audit row is recorded for a rejected wrong-amount capture',
    not exists (select 1 from audit_logs where action = 'payment_completed' and target_id = v_payment_id::text));
  perform test_assert('a payment_amount_mismatch audit row records the expected vs received amount for investigation',
    exists (
      select 1 from audit_logs
      where action = 'payment_amount_mismatch' and target_id = v_payment_id::text
        and (metadata->>'expected_amount_in_smallest_unit')::bigint = 150000
        and (metadata->>'received_amount_in_smallest_unit')::bigint = 100000
    ));
  raise notice 'OK: a captured event reporting the wrong amount is rejected without ever marking the payment succeeded';
end;
$$;

-- 11b. Wrong currency: rejected the same way.
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-00000000000a';
  perform reconcile_razorpay_payment('payment.captured:pay_AMT_000A', 'captured', 'order_AMOUNTCHK000A', 'pay_AMT_000A', 150000, 'USD', '{}'::jsonb);

  perform test_assert('a captured event reporting the wrong currency is rejected -- payment stays pending',
    (select status from payments where id = v_payment_id) = 'pending');
  perform test_assert('a payment_amount_mismatch audit row records the currency mismatch',
    exists (
      select 1 from audit_logs
      where action = 'payment_amount_mismatch' and target_id = v_payment_id::text
        and metadata->>'expected_currency' = 'INR' and metadata->>'received_currency' = 'USD'
    ));
  raise notice 'OK: a captured event reporting the wrong currency is rejected without ever marking the payment succeeded';
end;
$$;

-- 11c. Fractional INR amount: round(999.50 * 100) = 99950 exactly, no
--      floating-point drift.
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-00000000000b';
  perform reconcile_razorpay_payment('payment.captured:pay_AMT_000B', 'captured', 'order_AMOUNTCHK000B', 'pay_AMT_000B', 99950, 'INR', '{}'::jsonb);

  perform test_assert('a fractional INR amount (999.50) converts to exactly 99950 paise and is accepted',
    (select status from payments where id = v_payment_id) = 'succeeded');
  raise notice 'OK: fractional decimal-to-paise conversion is exact';
end;
$$;

-- 11d. Correct amount + case-insensitive currency match ('inr' vs 'INR').
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-00000000000c';
  perform reconcile_razorpay_payment('payment.captured:pay_AMT_000C', 'captured', 'order_AMOUNTCHK000C', 'pay_AMT_000C', 150000, 'inr', '{}'::jsonb);

  perform test_assert('currency comparison is case-insensitive (lowercase "inr" matches stored "INR")',
    (select status from payments where id = v_payment_id) = 'succeeded');
  raise notice 'OK: correct amount with a differently-cased currency code is accepted';
end;
$$;

-- 11e. Missing amount (NULL): rejected, never succeeds.
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-00000000000d';
  perform reconcile_razorpay_payment('payment.captured:pay_AMT_000D', 'captured', 'order_AMOUNTCHK000D', 'pay_AMT_000D', null, 'INR', '{}'::jsonb);

  perform test_assert('a captured event with a missing (null) amount is rejected, not silently accepted',
    (select status from payments where id = v_payment_id) = 'pending');
  raise notice 'OK: a missing amount is rejected';
end;
$$;

-- 11f. Missing currency (NULL): rejected, never succeeds.
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-00000000000e';
  perform reconcile_razorpay_payment('payment.captured:pay_AMT_000E', 'captured', 'order_AMOUNTCHK000E', 'pay_AMT_000E', 150000, null, '{}'::jsonb);

  perform test_assert('a captured event with a missing (null) currency is rejected, not silently accepted',
    (select status from payments where id = v_payment_id) = 'pending');
  raise notice 'OK: a missing currency is rejected';
end;
$$;

-- 11g. Large amount: round(999999.99 * 100) = 99999999 -- no overflow, no
--      precision loss at a realistic upper bound.
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-00000000000f';
  perform reconcile_razorpay_payment('payment.captured:pay_AMT_000F', 'captured', 'order_AMOUNTCHK000F', 'pay_AMT_000F', 99999999, 'INR', '{}'::jsonb);

  perform test_assert('a large invoice amount (999999.99) converts and compares correctly with no overflow/precision loss',
    (select status from payments where id = v_payment_id) = 'succeeded');
  raise notice 'OK: a large amount is verified and accepted correctly';
end;
$$;

-- 11h. Zero/invalid provider amount: even though the invoice's real amount
--      is nonzero, a provider-reported amount of 0 must never match and
--      must never be accepted -- defense in depth at the SQL layer, in
--      addition to parseRazorpayPaymentWebhookEvent's own TypeScript-level
--      rejection of a non-positive amount before this RPC is ever called.
do $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id from payments where invoice_id = '14400001-0000-0000-0000-000000000010';
  perform reconcile_razorpay_payment('payment.captured:pay_AMT_0010', 'captured', 'order_AMOUNTCHK0010', 'pay_AMT_0010', 0, 'INR', '{}'::jsonb);

  perform test_assert('a zero provider-reported amount is rejected rather than treated as a match',
    (select status from payments where id = v_payment_id) = 'pending');
  raise notice 'OK: a zero/invalid provider amount is rejected';
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Unknown Razorpay order id: a validly-signed webhook referencing an
--     order this platform never created (no matching payments row) must be
--     a safe, deterministic, non-mutating no-op -- never a 500 from a
--     payment_attempts.company_id NOT NULL violation, and never persisted
--     under a fabricated or borrowed company_id.
-- ---------------------------------------------------------------------------

-- 12a. Unknown order -- captured: no exception, nothing created anywhere.
do $$
begin
  perform reconcile_razorpay_payment('payment.captured:pay_UNKNOWN_0001', 'captured', 'order_DOES_NOT_EXIST_0001', 'pay_UNKNOWN_0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('an unknown order id (captured) raises no exception and creates no payment_attempts row',
    not exists (select 1 from payment_attempts where provider_event_id = 'payment.captured:pay_UNKNOWN_0001'));
  perform test_assert('an unknown order id (captured) creates no payments row',
    not exists (select 1 from payments where provider_reference = 'order_DOES_NOT_EXIST_0001'));
  perform test_assert('an unknown order id (captured) creates no audit_logs row',
    not exists (select 1 from audit_logs where metadata->>'provider_payment_id' = 'pay_UNKNOWN_0001'));
  raise notice 'OK: an unknown order id on a captured event is a safe, unpersisted no-op (no not_null_violation, no 500)';
end;
$$;

-- 12b. Unknown order -- failed: same safe behavior.
do $$
begin
  perform reconcile_razorpay_payment('payment.failed:pay_UNKNOWN_0002', 'failed', 'order_DOES_NOT_EXIST_0002', 'pay_UNKNOWN_0002', 100000, 'INR', '{}'::jsonb);

  perform test_assert('an unknown order id (failed) raises no exception and creates no payment_attempts row',
    not exists (select 1 from payment_attempts where provider_event_id = 'payment.failed:pay_UNKNOWN_0002'));
  perform test_assert('an unknown order id (failed) creates no payments row',
    not exists (select 1 from payments where provider_reference = 'order_DOES_NOT_EXIST_0002'));
  perform test_assert('an unknown order id (failed) creates no audit_logs row',
    not exists (select 1 from audit_logs where metadata->>'provider_payment_id' = 'pay_UNKNOWN_0002'));
  raise notice 'OK: an unknown order id on a failed event is a safe, unpersisted no-op';
end;
$$;

-- 12c. Duplicate delivery of the same unknown-order event: deterministic,
--      no uncontrolled row growth (nothing was ever persisted for it, so
--      there is nothing to grow).
do $$
declare
  v_count_before int;
  v_count_after int;
begin
  select count(*) into v_count_before from payment_attempts where provider_event_id = 'payment.captured:pay_UNKNOWN_0003';

  perform reconcile_razorpay_payment('payment.captured:pay_UNKNOWN_0003', 'captured', 'order_DOES_NOT_EXIST_0003', 'pay_UNKNOWN_0003', 100000, 'INR', '{}'::jsonb);
  perform reconcile_razorpay_payment('payment.captured:pay_UNKNOWN_0003', 'captured', 'order_DOES_NOT_EXIST_0003', 'pay_UNKNOWN_0003', 100000, 'INR', '{}'::jsonb);

  select count(*) into v_count_after from payment_attempts where provider_event_id = 'payment.captured:pay_UNKNOWN_0003';
  perform test_assert('repeated delivery of the same unknown-order event stays at zero persisted rows (no 500, no growth)',
    v_count_before = 0 and v_count_after = 0);
  raise notice 'OK: repeated delivery of an unknown-order event converges deterministically with no persistence and no growth';
end;
$$;

-- 12d. Cross-company protection: an unknown order has no order-to-company
--      resolution path at all, so it cannot affect any company -- and
--      reconciling one alongside a real, already-known order for Company A
--      never disturbs either Company A's or Company B's own data.
do $$
declare
  v_b_period_end_before timestamptz;
  v_b_period_end_after timestamptz;
  v_a_payment_status_before payment_status;
  v_a_payment_status_after payment_status;
begin
  select current_period_end into v_b_period_end_before from subscriptions where company_id = 'd2000001-0000-0000-0000-000000000001';
  select status into v_a_payment_status_before from payments where provider_reference = 'order_TESTORDER0001';

  perform reconcile_razorpay_payment('payment.captured:pay_UNKNOWN_XCOMPANY', 'captured', 'order_DOES_NOT_EXIST_XCOMPANY', 'pay_UNKNOWN_XCOMPANY', 100000, 'INR', '{}'::jsonb);

  select current_period_end into v_b_period_end_after from subscriptions where company_id = 'd2000001-0000-0000-0000-000000000001';
  select status into v_a_payment_status_after from payments where provider_reference = 'order_TESTORDER0001';

  perform test_assert('reconciling an unknown order never touches Company B''s subscription',
    v_b_period_end_before = v_b_period_end_after);
  perform test_assert('reconciling an unknown order never disturbs Company A''s own real, already-known order',
    v_a_payment_status_before = v_a_payment_status_after);
  raise notice 'OK: an unknown order id has no order-to-company resolution path and cannot affect any company (the real order-to-payment relationship remains authoritative)';
end;
$$;

-- 12e. Known-order regression: the reordered lookup-before-persist logic
--      must not have broken normal, legitimate reconciliation of a real,
--      known order.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000001-0000-0000-0000-000000000001', '14400001-0000-0000-0000-000000000014', 'razorpay', 'pending', 750.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_REGRESSION_0014' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_REGRESSION_0014', 'captured', 'order_REGRESSION_0014', 'pay_REGRESSION_0014', 75000, 'INR', '{}'::jsonb);

  perform test_assert('a normal, known-order capture still succeeds correctly after the unknown-order fix',
    (select status from payments where id = v_payment_id) = 'succeeded');
  perform test_assert('the invoice behind a normal, known-order capture is still marked paid',
    exists (select 1 from invoices where id = '14400001-0000-0000-0000-000000000014' and status = 'paid'));
  perform test_assert('a payment_attempts row is recorded for the known order (idempotency preserved for real events)',
    exists (select 1 from payment_attempts where provider_event_id = 'payment.captured:pay_REGRESSION_0014' and company_id = 'd1000001-0000-0000-0000-000000000001'));
  raise notice 'OK: known-order reconciliation is unaffected by the unknown-order handling fix';
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Migration 29 (production-safety closeout): at-most-one-actionable-
--     order-per-invoice reuse in create_payment_order, and trial -> active
--     first-payment activation in reconcile_razorpay_payment. Everything in
--     sections 1-12 above already re-runs against this same migrated
--     function set (this file executes after all 29 migrations are applied),
--     so those sections are this migration's regression coverage -- no
--     existing assertion needed to change.
-- ---------------------------------------------------------------------------

select test_assert(
  'create_payment_order locks the invoice row with FOR UPDATE (the concurrency guarantee behind at-most-one-actionable-order-per-invoice -- a true concurrent-connections test is outside what this single-session psql harness can exercise, exactly like the equivalent reconcile_razorpay_payment check above)',
  pg_get_functiondef((select oid from pg_proc where proname = 'create_payment_order' limit 1)) ilike '%for update%'
);

insert into invoices (id, company_id, kind, invoice_number, status, currency, total) values
  ('14400001-0000-0000-0000-000000000015', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0015', 'pending', 'INR', 300.00),
  ('14400001-0000-0000-0000-000000000016', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0016', 'pending', 'INR', 300.00),
  ('14400001-0000-0000-0000-000000000017', 'd1000001-0000-0000-0000-000000000001', 'service_charge', 'INV-PAY-A-0017', 'pending', 'INR', 300.00);

reset role;
set local role authenticated;
select test_set_current_user('e0000001-0000-0000-0000-000000000001'); -- owner-a

-- 13a. Sequential duplicate Pay Now: a second click before any order is
--      attached reuses the first click's payment row; a third click after
--      an order IS attached reuses that same row and returns the order id
--      for reuse. At no point does a second row get created.
do $$
declare
  v_row1 record;
  v_row2 record;
  v_row3 record;
begin
  select * into v_row1 from create_payment_order('14400001-0000-0000-0000-000000000015');
  perform test_assert('first Pay Now click: no existing order yet, existing_provider_reference is null',
    v_row1.existing_provider_reference is null);

  select * into v_row2 from create_payment_order('14400001-0000-0000-0000-000000000015');
  perform test_assert('second Pay Now click before any order is attached: reuses the exact same payment row',
    v_row2.payment_id = v_row1.payment_id);
  perform test_assert('second Pay Now click before any order is attached: still no order id (nothing to attach yet)',
    v_row2.existing_provider_reference is null);
  perform test_assert('exactly one payment row exists for this invoice after two Pay Now clicks',
    (select count(*) from payments where invoice_id = '14400001-0000-0000-0000-000000000015') = 1);
  perform test_assert('exactly one payment_order_created audit row exists (the second click never re-audited)',
    (select count(*) from audit_logs where action = 'payment_order_created' and target_id = v_row1.payment_id::text) = 1);

  perform attach_razorpay_order(v_row1.payment_id, 'order_REUSE_A0015');

  select * into v_row3 from create_payment_order('14400001-0000-0000-0000-000000000015');
  perform test_assert('third Pay Now click after an order is already attached: reuses the same payment row',
    v_row3.payment_id = v_row1.payment_id);
  perform test_assert('third Pay Now click after an order is already attached: returns that exact order id for reuse',
    v_row3.existing_provider_reference = 'order_REUSE_A0015');
  perform test_assert('still exactly one payment row for this invoice after three Pay Now clicks total',
    (select count(*) from payments where invoice_id = '14400001-0000-0000-0000-000000000015') = 1);
  raise notice 'OK: repeated Pay Now clicks reuse the single unresolved payment/order for an invoice instead of creating a new one each time';
end;
$$;

-- 13b/13c fixtures: a payment row left without a provider_reference
-- (order-creation interrupted before attach_razorpay_order ran) and an
-- already-failed payment. Both must be inserted directly under
-- service_role (bypassrls) -- exactly like every other direct payments
-- fixture in this file -- since authenticated has no INSERT policy on
-- payments at all (the only allowed write path is the SECURITY DEFINER
-- RPC). A temp table carries the resulting ids across the role switch back
-- to authenticated for the create_payment_order calls below.
create temp table reuse_scratch_13 (label text, id uuid) on commit drop;
grant select, insert on reuse_scratch_13 to authenticated, service_role;

reset role;
set local role service_role;

with ins as (
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000001-0000-0000-0000-000000000001', '14400001-0000-0000-0000-000000000016', 'razorpay', 'pending', 300.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id
)
insert into reuse_scratch_13 (label, id) select 'interrupted', id from ins;

with ins as (
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id, provider_reference)
    values ('d1000001-0000-0000-0000-000000000001', '14400001-0000-0000-0000-000000000017', 'razorpay', 'failed', 300.00, 'INR', 'e0000001-0000-0000-0000-000000000001', 'order_FAILED_A0017')
    returning id
)
insert into reuse_scratch_13 (label, id) select 'failed', id from ins;

reset role;
set local role authenticated;
select test_set_current_user('e0000001-0000-0000-0000-000000000001'); -- owner-a

-- 13b. A payment row left without a provider_reference (order-creation
--      interrupted before attach_razorpay_order ran) is reused
--      deterministically, never duplicated.
do $$
declare
  v_interrupted_id uuid;
  v_row record;
begin
  select id into v_interrupted_id from reuse_scratch_13 where label = 'interrupted';

  select * into v_row from create_payment_order('14400001-0000-0000-0000-000000000016');
  perform test_assert('an interrupted (order-less) pending payment is reused rather than duplicated',
    v_row.payment_id = v_interrupted_id and v_row.existing_provider_reference is null);
  perform test_assert('exactly one payment row exists for this invoice',
    (select count(*) from payments where invoice_id = '14400001-0000-0000-0000-000000000016') = 1);
  raise notice 'OK: a payment row left without a provider_reference is reused deterministically, never duplicated';
end;
$$;

-- 13c. A failed payment is never reused: the next Pay Now click for the
--      same invoice creates a genuinely new row/order, matching Razorpay's
--      own one-order-per-attempt model for retrying a declined payment.
do $$
declare
  v_failed_id uuid;
  v_row record;
begin
  select id into v_failed_id from reuse_scratch_13 where label = 'failed';

  select * into v_row from create_payment_order('14400001-0000-0000-0000-000000000017');
  perform test_assert('a failed payment is not reused -- the next Pay Now click creates a genuinely new row',
    v_row.payment_id <> v_failed_id and v_row.existing_provider_reference is null);
  perform test_assert('both the old failed row and the new pending row now exist for this invoice',
    (select count(*) from payments where invoice_id = '14400001-0000-0000-0000-000000000017') = 2);
  raise notice 'OK: a failed payment does not block a fresh retry attempt from getting its own new order';
end;
$$;

-- 13d. A paid invoice is still rejected outright regardless of the reuse
--      logic -- the invoice-status guard runs before the reuse lookup.
select test_assert_raises_like(
  'a paid invoice is rejected by create_payment_order regardless of the reuse logic',
  $sql$ select * from create_payment_order('14400001-0000-0000-0000-000000000002') $sql$,
  'invoice_not_payable'
);

reset role;
set local role service_role;

-- ---------------------------------------------------------------------------
-- 13e-13k. Trial -> active first-payment activation.
-- ---------------------------------------------------------------------------

insert into companies (id, name, slug, status, is_demo) values
  ('d1000010-0000-0000-0000-000000000001', 'Pay Co J (trial, unexpired)', 'pay-co-j', 'active', true),
  ('d1000011-0000-0000-0000-000000000001', 'Pay Co K (trial, expired)', 'pay-co-k', 'active', true),
  ('d1000012-0000-0000-0000-000000000001', 'Pay Co L (trial, amount mismatch)', 'pay-co-l', 'active', true),
  ('d1000013-0000-0000-0000-000000000001', 'Pay Co M (trial, currency mismatch)', 'pay-co-m', 'active', true),
  ('d1000014-0000-0000-0000-000000000001', 'Pay Co N (trial, failed payment)', 'pay-co-n', 'active', true);

insert into subscriptions (id, company_id, plan_version_id, state, current_period_start, current_period_end) values
  ('13300010-0000-0000-0000-000000000001', 'd1000010-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'trial', now() - interval '10 days', now() + interval '4 days'),
  ('13300011-0000-0000-0000-000000000001', 'd1000011-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'trial', now() - interval '17 days', now() - interval '3 days'),
  ('13300012-0000-0000-0000-000000000001', 'd1000012-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'trial', now() - interval '5 days', now() + interval '9 days'),
  ('13300013-0000-0000-0000-000000000001', 'd1000013-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'trial', now() - interval '5 days', now() + interval '9 days'),
  ('13300014-0000-0000-0000-000000000001', 'd1000014-0000-0000-0000-000000000001', '11200001-0000-0000-0000-000000000001', 'trial', now() - interval '5 days', now() + interval '9 days');

insert into invoices (id, company_id, kind, invoice_number, status, currency, total) values
  ('14400010-0000-0000-0000-000000000001', 'd1000010-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-J-0001', 'pending', 'INR', 1000.00),
  ('14400011-0000-0000-0000-000000000001', 'd1000011-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-K-0001', 'pending', 'INR', 1000.00),
  ('14400012-0000-0000-0000-000000000001', 'd1000012-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-L-0001', 'pending', 'INR', 1000.00),
  ('14400013-0000-0000-0000-000000000001', 'd1000013-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-M-0001', 'pending', 'INR', 1000.00),
  ('14400014-0000-0000-0000-000000000001', 'd1000014-0000-0000-0000-000000000001', 'subscription', 'INV-PAY-N-0001', 'pending', 'INR', 1000.00);

-- 13e. Canonical success case, using an UNEXPIRED trial (4 days still
--      remaining) to prove the new paid period starts at reconciliation
--      time, never waiting for the trial's own remaining days to elapse.
--      Also covers duplicate-webhook idempotency for this new branch.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000010-0000-0000-0000-000000000001', '14400010-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_TRIAL_J0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_TRIAL_J0001', 'captured', 'order_TRIAL_J0001', 'pay_TRIAL_J0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('trial + successful payment: subscription state becomes active',
    (select state from subscriptions where company_id = 'd1000010-0000-0000-0000-000000000001') = 'active');
  perform test_assert('trial + successful payment (unexpired trial): new period starts at reconciliation time (now()), never waiting for the remaining trial days',
    (select current_period_start from subscriptions where company_id = 'd1000010-0000-0000-0000-000000000001') = now());
  perform test_assert('trial + successful payment: new period end is exactly one month after the new start',
    (select current_period_end from subscriptions where company_id = 'd1000010-0000-0000-0000-000000000001') = now() + interval '1 month');
  perform test_assert('trial + successful payment: the invoice is marked paid',
    (select status from invoices where id = '14400010-0000-0000-0000-000000000001') = 'paid');
  perform test_assert('trial + successful payment: exactly one subscription_event was recorded, using the activate event (never payment_recovered)',
    (select count(*) from subscription_events where subscription_id = '13300010-0000-0000-0000-000000000001') = 1
    and (select event from subscription_events where subscription_id = '13300010-0000-0000-0000-000000000001') = 'activate'
    and (select from_state from subscription_events where subscription_id = '13300010-0000-0000-0000-000000000001') = 'trial'
    and (select to_state from subscription_events where subscription_id = '13300010-0000-0000-0000-000000000001') = 'active');

  perform reconcile_razorpay_payment('payment.captured:pay_TRIAL_J0001', 'captured', 'order_TRIAL_J0001', 'pay_TRIAL_J0001', 100000, 'INR', '{}'::jsonb);
  perform test_assert('duplicate captured webhook for the same trial activation: still exactly one subscription_event',
    (select count(*) from subscription_events where subscription_id = '13300010-0000-0000-0000-000000000001') = 1);
  perform test_assert('duplicate captured webhook for the same trial activation: the period is not extended a second time',
    (select current_period_end from subscriptions where company_id = 'd1000010-0000-0000-0000-000000000001') = now() + interval '1 month');
  raise notice 'OK: a trial subscription''s first successful payment activates it exactly once, with the activate event and a period starting from now()';
end;
$$;

-- 13f. Trial + expired period: same success path, proving the new period
--      starts at now() and NOT at the trial's own (already past)
--      current_period_end -- an expired trial must never grant a paid
--      period that starts in the past.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000011-0000-0000-0000-000000000001', '14400011-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_TRIAL_K0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_TRIAL_K0001', 'captured', 'order_TRIAL_K0001', 'pay_TRIAL_K0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('trial + successful payment (expired trial): subscription state becomes active',
    (select state from subscriptions where company_id = 'd1000011-0000-0000-0000-000000000001') = 'active');
  perform test_assert('trial + successful payment (expired trial): new period starts at now(), never at the stale expired trial end',
    (select current_period_start from subscriptions where company_id = 'd1000011-0000-0000-0000-000000000001') = now());
  raise notice 'OK: an already-expired trial''s first payment still gets a fresh period starting from now(), never in the past';
end;
$$;

-- 13g. Trial + amount mismatch: never activated, invoice never paid,
--      exactly like the existing (non-trial) amount-mismatch protection.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000012-0000-0000-0000-000000000001', '14400012-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_TRIAL_L0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_TRIAL_L0001', 'captured', 'order_TRIAL_L0001', 'pay_TRIAL_L0001', 50000, 'INR', '{}'::jsonb);

  perform test_assert('trial + amount mismatch: subscription remains trial',
    (select state from subscriptions where company_id = 'd1000012-0000-0000-0000-000000000001') = 'trial');
  perform test_assert('trial + amount mismatch: invoice remains unpaid',
    (select status from invoices where id = '14400012-0000-0000-0000-000000000001') = 'pending');
  perform test_assert('trial + amount mismatch: no subscription_event was recorded',
    not exists (select 1 from subscription_events where subscription_id = '13300012-0000-0000-0000-000000000001'));
  perform test_assert('trial + amount mismatch: a payment_amount_mismatch audit row was recorded',
    exists (select 1 from audit_logs where action = 'payment_amount_mismatch' and target_id = v_payment_id::text));
  raise notice 'OK: an amount mismatch never activates a trial subscription, exactly like the existing non-trial protection';
end;
$$;

-- 13h. Trial + currency mismatch: never activated.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000013-0000-0000-0000-000000000001', '14400013-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_TRIAL_M0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.captured:pay_TRIAL_M0001', 'captured', 'order_TRIAL_M0001', 'pay_TRIAL_M0001', 100000, 'USD', '{}'::jsonb);

  perform test_assert('trial + currency mismatch: subscription remains trial',
    (select state from subscriptions where company_id = 'd1000013-0000-0000-0000-000000000001') = 'trial');
  perform test_assert('trial + currency mismatch: invoice remains unpaid',
    (select status from invoices where id = '14400013-0000-0000-0000-000000000001') = 'pending');
  raise notice 'OK: a currency mismatch never activates a trial subscription';
end;
$$;

-- 13i. Trial + failed payment: never activated.
do $$
declare
  v_payment_id uuid;
begin
  insert into payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values ('d1000014-0000-0000-0000-000000000001', '14400014-0000-0000-0000-000000000001', 'razorpay', 'pending', 1000.00, 'INR', 'e0000001-0000-0000-0000-000000000001')
    returning id into v_payment_id;
  update payments set provider_reference = 'order_TRIAL_N0001' where id = v_payment_id;

  perform reconcile_razorpay_payment('payment.failed:pay_TRIAL_N0001', 'failed', 'order_TRIAL_N0001', 'pay_TRIAL_N0001', 100000, 'INR', '{}'::jsonb);

  perform test_assert('trial + failed payment: subscription remains trial',
    (select state from subscriptions where company_id = 'd1000014-0000-0000-0000-000000000001') = 'trial');
  perform test_assert('trial + failed payment: the payment row itself is marked failed',
    (select status from payments where id = v_payment_id) = 'failed');
  perform test_assert('trial + failed payment: invoice remains unpaid',
    (select status from invoices where id = '14400014-0000-0000-0000-000000000001') = 'pending');
  raise notice 'OK: a failed payment never activates a trial subscription';
end;
$$;

-- 13j. Cross-tenant isolation of trial activation: Company J's and Company
--      K's activations (13e, 13f) never leaked into each other, and neither
--      touched the mismatch/failed companies (13g-13i), which correctly
--      remain in trial.
do $$
begin
  perform test_assert('Company J and Company K each activated independently, with no cross-tenant leakage',
    (select state from subscriptions where company_id = 'd1000010-0000-0000-0000-000000000001') = 'active'
    and (select state from subscriptions where company_id = 'd1000011-0000-0000-0000-000000000001') = 'active'
    and (select count(*) from subscription_events where subscription_id = '13300010-0000-0000-0000-000000000001') = 1
    and (select count(*) from subscription_events where subscription_id = '13300011-0000-0000-0000-000000000001') = 1);
  perform test_assert('Companies L, M, N (mismatch/failed) remain in trial, untouched by J/K''s activation',
    (select state from subscriptions where company_id = 'd1000012-0000-0000-0000-000000000001') = 'trial'
    and (select state from subscriptions where company_id = 'd1000013-0000-0000-0000-000000000001') = 'trial'
    and (select state from subscriptions where company_id = 'd1000014-0000-0000-0000-000000000001') = 'trial');
  raise notice 'OK: trial activation is fully tenant-isolated, exactly like every other reconciliation path';
end;
$$;

reset role;

rollback;
