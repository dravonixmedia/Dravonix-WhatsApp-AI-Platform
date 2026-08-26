-- Dravonix WhatsApp AI Platform
-- Phase 6B production-safety closeout: two gaps surfaced by the first real
-- Razorpay Test Mode transaction against staging (Migration 28, already
-- applied and immutable -- this migration never edits it, only builds
-- forward from it).
--
-- Scope, deliberately minimal (no invoice generation, no renewal
-- reminders, no scheduled billing worker, no Super Admin billing UI --
-- all explicitly deferred to a later phase):
--
--   1. create_payment_order: an invoice may now have at most one
--      currently-actionable (status = 'pending') Razorpay payment row.
--      Repeated Pay Now clicks -- sequential or concurrent -- reuse the
--      existing unresolved payment/order instead of minting a new
--      Razorpay order every time. Concurrency safety comes from the
--      SAME invoice `for update` lock migration 28 already took (a second
--      concurrent caller blocks on that lock until the first transaction
--      commits, then observes its just-inserted row) -- no new locking
--      primitive, no new column, no new payment_status value.
--
--   2. reconcile_razorpay_payment: a subscription-kind invoice paid while
--      the subscription is in `trial` now activates it (trial -> active,
--      the state machine's own `activate` event -- packages/billing/src/
--      stateMachine.ts:45-46), instead of leaving it silently untouched.
--      `payment_recovered` is intentionally left scoped to exactly the
--      same four pre-states migration 28 already defined
--      ({active, payment_due, grace_period, suspended}) -- trial was never
--      one of them in the real state machine, so this is a genuinely new
--      branch, never a repurposing of payment_recovered. The new paid
--      period always starts at the moment of reconciliation (never
--      extended from the trial's own current_period_end, which is free
--      product usage, not a billing cycle boundary) -- see the function
--      comment below for the exact product-decision rationale.

-- ---------------------------------------------------------------------------
-- 1. create_payment_order: add at-most-one-actionable-order-per-invoice
--    reuse. Return signature changes (adds existing_provider_reference),
--    so the function is dropped and recreated rather than replaced in
--    place.
-- ---------------------------------------------------------------------------

drop function if exists create_payment_order(uuid);

create function create_payment_order(p_invoice_id uuid)
returns table (
  payment_id uuid,
  amount numeric,
  currency text,
  invoice_number text,
  company_id uuid,
  -- Non-null only when an existing pending payment for this invoice
  -- already has a Razorpay order attached: the caller must reuse this
  -- order id directly and skip both the Razorpay Orders API call and
  -- attach_razorpay_order. Null in every other case (first payment for
  -- this invoice, or a reused-but-not-yet-attached row), in which the
  -- caller proceeds exactly as before (create the Razorpay order, then
  -- attach_razorpay_order) using the returned payment_id.
  existing_provider_reference text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices%rowtype;
  v_payment_id uuid;
  v_existing public.payments%rowtype;
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

  -- Reuse check. The invoice `for update` lock taken above is what makes
  -- this concurrency-safe: two simultaneous Pay Now calls for the SAME
  -- invoice cannot both reach this SELECT with a stale view of the
  -- world -- the second caller's transaction blocks on the lock until the
  -- first commits (inserting its new payment row) or rolls back, then
  -- re-reads here and correctly finds/reuses that row. Only a 'pending'
  -- row is reusable -- 'succeeded' and 'failed' are unaffected (a failed
  -- attempt may still get a fresh row/order on the next click, matching
  -- Razorpay's own one-order-per-attempt model); 'pending' covers both an
  -- abandoned checkout (no provider_reference yet stuck, or one already
  -- attached and simply never completed) and a row whose order-creation
  -- step was interrupted before attach_razorpay_order ran. Ordered by
  -- created_at desc as a deterministic tie-breaker in case any row from
  -- before this migration already violates the at-most-one invariant.
  select * into v_existing from public.payments
    where invoice_id = v_invoice.id and method = 'razorpay' and status = 'pending'
    order by created_at desc
    limit 1;

  if found then
    return query select v_existing.id, v_existing.amount, v_existing.currency,
      v_invoice.invoice_number, v_invoice.company_id, v_existing.provider_reference;
    return;
  end if;

  insert into public.payments (company_id, invoice_id, method, status, amount, currency, submitted_by_user_id)
    values (v_invoice.company_id, v_invoice.id, 'razorpay', 'pending', v_invoice.total, v_invoice.currency, auth.uid())
    returning id into v_payment_id;

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (v_invoice.company_id, auth.uid(), 'user', 'payment_order_created', 'payment', v_payment_id::text,
            jsonb_build_object('invoice_id', v_invoice.id, 'amount', v_invoice.total, 'currency', v_invoice.currency));

  return query select v_payment_id, v_invoice.total, v_invoice.currency, v_invoice.invoice_number,
    v_invoice.company_id, null::text;
end;
$$;

comment on function create_payment_order(uuid) is
  'Phase 6B production-safety closeout (migration 29): as migration 28 (validates billing.pay + invoice payability/ownership derived from the invoice row), plus at-most-one-actionable-razorpay-order-per-invoice reuse -- an existing pending payment row for the same invoice is returned (with its provider_reference, possibly null) instead of a new row/order being created. Concurrency-safe via the pre-existing invoice FOR UPDATE lock.';

revoke all on function create_payment_order(uuid) from public, anon;
grant execute on function create_payment_order(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. reconcile_razorpay_payment: add trial -> active first-payment
--    activation. Return type (void) is unchanged, so this is a plain
--    create-or-replace -- every other branch (unknown order, idempotency,
--    amount/currency verification, the succeeded-is-terminal /
--    failed-is-not-terminal rules, the {active, payment_due, grace_period,
--    suspended} payment_recovered branch and its renewal-timing rule) is
--    copied verbatim from migration 28, byte-for-byte except for the one
--    new `elsif` branch added below.
-- ---------------------------------------------------------------------------

create or replace function reconcile_razorpay_payment(
  p_provider_event_id text,
  p_event_status text,
  p_razorpay_order_id text,
  p_razorpay_payment_id text,
  p_amount_in_smallest_unit bigint,
  p_currency text,
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
  v_now timestamptz := now();
  v_new_period_start timestamptz;
  v_new_period_end timestamptz;
  v_expected_amount bigint;
begin
  begin
    select * into strict v_payment from public.payments
      where provider_reference = p_razorpay_order_id and method = 'razorpay'
      for update;
  exception
    when no_data_found then
      return;
    when too_many_rows then
      raise exception 'ambiguous_provider_reference';
  end;

  begin
    insert into public.payment_attempts (company_id, provider, provider_event_id, status, raw_payload, processed_at)
      values (v_payment.company_id, 'razorpay', p_provider_event_id, p_event_status, p_raw_payload, v_now);
  exception when unique_violation then
    return;
  end;

  if p_event_status = 'captured' then
    if v_payment.status = 'succeeded' then
      return;
    end if;

    v_expected_amount := round(v_payment.amount * 100);
    if p_amount_in_smallest_unit is null or p_currency is null
       or p_amount_in_smallest_unit <> v_expected_amount
       or upper(trim(p_currency)) <> upper(trim(v_payment.currency)) then
      insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
        values (v_payment.company_id, null, 'system', 'payment_amount_mismatch', 'payment', v_payment.id::text,
                jsonb_build_object(
                  'provider_payment_id', p_razorpay_payment_id,
                  'expected_amount_in_smallest_unit', v_expected_amount,
                  'received_amount_in_smallest_unit', p_amount_in_smallest_unit,
                  'expected_currency', v_payment.currency,
                  'received_currency', p_currency
                ));
      return;
    end if;

    update public.payments
      set status = 'succeeded', provider_payment_id = p_razorpay_payment_id
      where id = v_payment.id;

    if v_payment.invoice_id is not null then
      select * into v_invoice from public.invoices where id = v_payment.invoice_id for update;
      if found and v_invoice.status <> 'paid' then
        update public.invoices set status = 'paid', paid_date = v_now::date where id = v_invoice.id;

        if v_invoice.kind = 'subscription' then
          select * into v_subscription from public.subscriptions where company_id = v_payment.company_id for update;
          if found then
            v_old_state := v_subscription.state;
            if v_old_state in ('active', 'payment_due', 'grace_period', 'suspended') then
              v_new_period_start := greatest(coalesce(v_subscription.current_period_end, v_now), v_now);
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
            elsif v_old_state = 'trial' then
              -- First-payment activation (migration 29). payment_recovered
              -- is reserved for RECOVERING an already-paying subscription
              -- that fell behind -- packages/billing/src/stateMachine.ts
              -- defines it only for {active, payment_due, grace_period,
              -- suspended}; trial has no payment_recovered transition at
              -- all. A trial's first successful payment instead uses the
              -- state machine's own `activate` event (trial -> active,
              -- stateMachine.ts:45-46).
              --
              -- Product decision (documented here since no prior ADR/doc
              -- covers this case -- checked docs/architecture/adr-0006 and
              -- BILLING_AND_SUSPENSION.md, neither mentions early/late
              -- trial payment): the new paid period always starts at v_now
              -- (the moment of reconciliation), never derived from
              -- v_subscription.current_period_end. The trial's
              -- current_period_end marks free product-usage expiry, not a
              -- billing-cycle boundary, so: (a) an already-expired trial
              -- must never retroactively grant a period starting in the
              -- past, and (b) an unexpired trial's remaining free days are
              -- deliberately NOT carried over/prorated into the paid
              -- period -- no proration model exists anywhere in this
              -- codebase, and inventing one here would be exactly the kind
              -- of parallel billing system this migration must not create.
              v_new_period_start := v_now;
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
                  (v_payment.company_id, v_subscription.id, v_old_state, 'active', 'activate', false, null, p_provider_event_id,
                   'razorpay first-payment activation ' || coalesce(p_razorpay_payment_id, ''));
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
    if v_payment.status = 'succeeded' then
      return;
    end if;

    update public.payments set status = 'failed' where id = v_payment.id;

    insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
      values (v_payment.company_id, null, 'system', 'payment_failed', 'payment', v_payment.id::text,
              jsonb_build_object('provider_payment_id', p_razorpay_payment_id));
  end if;
end;
$$;

comment on function reconcile_razorpay_payment(text, text, text, text, bigint, text, jsonb) is
  'Phase 6B production-safety closeout (migration 29): as migration 28 (unknown-order safe no-op, idempotency, amount/currency verification, succeeded-is-terminal, {active,payment_due,grace_period,suspended} payment_recovered renewal), plus a trial -> active first-payment activation branch (state machine''s own activate event, never payment_recovered) with the new paid period starting at reconciliation time rather than the trial''s own current_period_end. service_role only -- never callable with an end-user JWT.';

revoke all on function reconcile_razorpay_payment(text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function reconcile_razorpay_payment(text, text, text, text, bigint, text, jsonb) to service_role;
