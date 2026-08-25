-- Dravonix WhatsApp AI Platform
-- Phase 6B: real client payment capability via Razorpay Orders + Checkout
-- (one-time payments only -- Razorpay Subscriptions is explicitly NOT used;
-- DRAIVA's own subscription_state machine in packages/billing remains the
-- sole source of truth for entitlement/renewal, exactly as ADR-0006 already
-- established). This migration is additive only: no existing table,
-- column, policy, or function from migrations 1-27 is altered.
--
-- Scope, deliberately minimal:
--   1. One new permission (billing.pay) and its three role grants.
--   2. Three new RPCs: two authenticated-caller RPCs that create a payment
--      intent and attach the resulting Razorpay order id, and one
--      service_role-only RPC that idempotently reconciles a completed/
--      failed webhook event across payments/invoices/subscriptions/
--      subscription_events/audit_logs in a single transaction.
-- No new table is needed: payments.provider_reference already exists and
-- is unused for anything else -- it holds the Razorpay order id; the
-- existing provider_payment_id column holds the Razorpay payment id once
-- captured, exactly matching its pre-existing name/intent.

-- ---------------------------------------------------------------------------
-- 1. billing.pay: initiate/submit a payment for the caller's own company.
--    Deliberately narrow -- see the function bodies below for the exact
--    boundary. Never billing.manage (still revoked from every client role
--    since migration 22, and not reinstated here).
-- ---------------------------------------------------------------------------

insert into permissions (key, description) values
  ('billing.pay', 'Initiate a Razorpay payment for the company''s own invoice');

insert into role_permissions (role, permission_key) values
  ('company_owner', 'billing.pay'),
  ('company_admin', 'billing.pay'),
  ('company_accounts', 'billing.pay');

-- ---------------------------------------------------------------------------
-- 2. create_payment_order: authenticated-caller entry point. Never accepts a
--    company_id -- company is derived exclusively from the invoice row
--    itself (invoices.company_id), so a forged/foreign invoice id is
--    rejected by the permission check on THAT company, not by trusting
--    anything the caller claims about their own membership. Amount and
--    currency are read from the invoice, never accepted as parameters --
--    there is no amount/currency parameter on this function at all.
-- ---------------------------------------------------------------------------

create or replace function create_payment_order(p_invoice_id uuid)
returns table (payment_id uuid, amount numeric, currency text, invoice_number text, company_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices%rowtype;
  v_payment_id uuid;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then raise exception 'invoice_not_found'; end if;

  if not public.has_company_permission(v_invoice.company_id, 'billing.pay') then
    raise exception 'permission_denied';
  end if;

  if v_invoice.status in ('paid', 'void', 'refunded') then
    raise exception 'invoice_not_payable';
  end if;

  if v_invoice.total <= 0 then
    raise exception 'invoice_amount_invalid';
  end if;

  insert into public.payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values (v_invoice.company_id, v_invoice.id, 'razorpay', 'pending', v_invoice.total, v_invoice.currency, auth.uid())
    returning id into v_payment_id;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_invoice.company_id, auth.uid(), 'user', 'payment_order_created', 'payment', v_payment_id::text,
            jsonb_build_object('invoice_id', v_invoice.id, 'amount', v_invoice.total, 'currency', v_invoice.currency));

  return query select v_payment_id, v_invoice.total, v_invoice.currency, v_invoice.invoice_number, v_invoice.company_id;
end;
$$;

comment on function create_payment_order(uuid) is
  'Phase 6B step 1: validates billing.pay + invoice payability/ownership (derived from the invoice row, never a client-supplied company_id) and creates a pending payments row with the server-verified amount/currency. Returns just enough for the caller to create a Razorpay Order server-side and render Checkout -- never the full row.';

revoke all on function create_payment_order(uuid) from public, anon;
grant execute on function create_payment_order(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. attach_razorpay_order: records the Razorpay order id returned by the
--    Orders API call the Server Action makes between step 2 and step 3
--    (that HTTP call cannot happen inside Postgres). Scoped to the exact
--    pending payment row the caller themselves just created in step 2 --
--    never any other company's or user's row, and only once.
-- ---------------------------------------------------------------------------

create or replace function attach_razorpay_order(p_payment_id uuid, p_razorpay_order_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if p_razorpay_order_id is null or trim(p_razorpay_order_id) = '' then
    raise exception 'invalid_order_id';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then raise exception 'payment_not_found'; end if;
  if v_payment.submitted_by_user_id is distinct from auth.uid() then raise exception 'permission_denied'; end if;
  if v_payment.method is distinct from 'razorpay' then raise exception 'invalid_payment_method'; end if;
  if v_payment.status is distinct from 'pending' then raise exception 'payment_not_pending'; end if;
  if v_payment.provider_reference is not null then raise exception 'order_already_attached'; end if;

  update public.payments set provider_reference = p_razorpay_order_id where id = p_payment_id;
end;
$$;

comment on function attach_razorpay_order(uuid, text) is
  'Phase 6B step 2: attaches the Razorpay order id to the exact pending payment row the caller created via create_payment_order -- re-checks submitted_by_user_id (never trusts the payment id alone), pending status, and that no order id is already attached (write-once).';

revoke all on function attach_razorpay_order(uuid, text) from public, anon;
grant execute on function attach_razorpay_order(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. reconcile_razorpay_payment: the ONLY place a payment/invoice/
--    subscription actually transitions on a completed or failed payment.
--    service_role only -- there is no authenticated-caller path to this
--    function at all, matching migration 12's service_role-only
--    reconcile_outbound_message precedent exactly. Idempotent via
--    payment_attempts' existing unique(provider, provider_event_id)
--    constraint (a duplicate delivery hits that unique violation and
--    returns immediately without reprocessing); also idempotent against a
--    payment that has already left 'pending' (webhook-then-callback or
--    callback-then-webhook both converge to the same final state, and a
--    retried webhook for an already-reconciled payment is a safe no-op).
--
--    Only a 'subscription'-kind invoice being paid advances the
--    subscription's period/state (payment_recovered, per the existing
--    state machine in packages/billing/src/stateMachine.ts -- mirrored
--    here in SQL since a plpgsql function cannot import that TS module;
--    the mirrored set of valid pre-states, {active, payment_due,
--    grace_period, suspended}, is copied verbatim from
--    subscriptionTransitions' payment_recovered entries and must be kept
--    in sync by hand if that table ever changes). A service_charge or
--    usage_overage invoice is marked paid but never touches a subscription
--    row, exactly as required.
-- ---------------------------------------------------------------------------

create or replace function reconcile_razorpay_payment(
  p_provider_event_id text,
  p_event_status text,
  p_razorpay_order_id text,
  p_razorpay_payment_id text,
  p_raw_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_subscription public.subscriptions%rowtype;
  v_old_state public.subscription_state;
  v_new_period_start timestamptz;
  v_new_period_end timestamptz;
  v_company_id uuid;
begin
  select company_id into v_company_id from public.payments where provider_reference = p_razorpay_order_id;

  begin
    insert into public.payment_attempts (company_id, provider, provider_event_id, status, raw_payload, processed_at)
      values (v_company_id, 'razorpay', p_provider_event_id, p_event_status, p_raw_payload, now());
  exception when unique_violation then
    -- Razorpay already delivered this exact event (retry) -- never reprocess.
    return;
  end;

  select * into v_payment from public.payments
    where provider_reference = p_razorpay_order_id and method = 'razorpay'
    for update;
  if not found then
    -- Unknown order id (e.g. a stray/foreign test event) -- nothing to reconcile.
    return;
  end if;

  if v_payment.status <> 'pending' then
    -- Already reconciled by an earlier callback or webhook delivery -- idempotent no-op.
    return;
  end if;

  if p_event_status = 'captured' then
    update public.payments
      set status = 'succeeded', provider_payment_id = p_razorpay_payment_id
      where id = v_payment.id;

    if v_payment.invoice_id is not null then
      select * into v_invoice from public.invoices where id = v_payment.invoice_id for update;
      if found and v_invoice.status <> 'paid' then
        update public.invoices set status = 'paid', paid_date = current_date where id = v_invoice.id;

        if v_invoice.kind = 'subscription' then
          select * into v_subscription from public.subscriptions where company_id = v_payment.company_id for update;
          if found then
            v_old_state := v_subscription.state;
            if v_old_state in ('active', 'payment_due', 'grace_period', 'suspended') then
              v_new_period_start := coalesce(v_subscription.current_period_end, now());
              v_new_period_end := v_new_period_start + interval '1 month';
              update public.subscriptions
                set state = 'active',
                    current_period_start = v_new_period_start,
                    current_period_end = v_new_period_end,
                    grace_period_end = null
                where id = v_subscription.id;

              insert into public.subscription_events
                  (company_id, subscription_id, from_state, to_state, event, is_manual_override, actor_user_id, provider_event_id, notes)
                values
                  (v_payment.company_id, v_subscription.id, v_old_state, 'active', 'payment_recovered', false, null, p_provider_event_id,
                   'razorpay payment ' || coalesce(p_razorpay_payment_id, ''));
            end if;
          end if;
        end if;
      end if;
    end if;

    insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
      values (v_payment.company_id, null, 'system', 'payment_completed', 'payment', v_payment.id::text,
              jsonb_build_object(
                'provider_payment_id', p_razorpay_payment_id,
                'invoice_id', v_payment.invoice_id,
                'submitted_by_user_id', v_payment.submitted_by_user_id
              ));
  elsif p_event_status = 'failed' then
    update public.payments set status = 'failed' where id = v_payment.id;

    insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
      values (v_payment.company_id, null, 'system', 'payment_failed', 'payment', v_payment.id::text,
              jsonb_build_object('provider_payment_id', p_razorpay_payment_id));
  end if;
end;
$$;

comment on function reconcile_razorpay_payment(text, text, text, text, jsonb) is
  'Phase 6B step 3 (webhook only): the sole place payment/invoice/subscription state actually transitions. Idempotent (payment_attempts unique(provider, provider_event_id) + a pending-status guard) and safe regardless of callback/webhook delivery order. service_role only -- never callable with an end-user JWT.';

revoke all on function reconcile_razorpay_payment(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function reconcile_razorpay_payment(text, text, text, text, jsonb) to service_role;
