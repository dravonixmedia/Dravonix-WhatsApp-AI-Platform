-- Dravonix WhatsApp AI Platform
-- Phase 7B: Super Admin subscription-lifecycle control plane.
--
-- Migrations 1-31 are immutable and are never touched here. This migration
-- has exactly three responsibilities, each independently minimal, matching
-- the Phase 7B pre-implementation architecture review:
--
--   1. Harden admin_change_subscription_state (migration 17) in place via
--      CREATE OR REPLACE, preserving its exact signature so no caller
--      breaks. The original wrote ANY (old_state, new_state) pair
--      unconditionally, using a single non-canonical 'manual_state_change'
--      subscription_events.event value, and never touched grace_period_end/
--      suspension_reason/cancellation_reason/reactivated_at. The replacement
--      validates the requested transition against the exact admin-allowed
--      edge set derived from packages/billing/src/stateMachine.ts (the
--      canonical TypeScript state machine, NOT modified here), rejects every
--      automatic-only and every forbidden transition (including anything
--      out of `closed`, which remains fully terminal), derives the correct
--      canonical event server-side (never trusting a client-supplied event
--      name), and updates exactly the ancillary columns each transition
--      genuinely requires -- current_period_start/current_period_end are
--      NEVER touched by this function, since no admin override here
--      represents a real payment event (that remains reconcile_razorpay_
--      payment's job alone, migrations 28/29, untouched).
--
--   2. Add admin_reset_company_entitlement: the previously-missing "restore
--      to plan default" capability for company_entitlements (migration 7).
--      Per the Phase 7B review of packages/billing's entitlement merge
--      (plan_entitlements populates a feature map first, then every
--      company_entitlements row for that company unconditionally overwrites
--      the same key), a plain DELETE of the override row is exactly
--      sufficient to restore plan-default behavior -- no other code path
--      needs to change, and plan_entitlements itself is never touched.
--
--   3. Add finalize_scheduled_subscription_cancellations: closes a genuine
--      pre-existing automation gap the Phase 7B review found -- nothing
--      anywhere ever converted a cancel_at_period_end subscription to
--      cancelled once its current_period_end actually passed (the canonical
--      period_ended_after_cancellation event was defined in stateMachine.ts
--      but never written by any migration). Mirrors
--      suspend_expired_grace_subscriptions's (migration 30) exact shape:
--      service_role-only, row-locked, idempotent, company-isolated by
--      construction, never touches invoices/payments, and never touches any
--      subscription outside cancel_at_period_end.
--
-- No table, column, enum, index, or trigger is created -- every requirement
-- is satisfiable with plain SECURITY DEFINER functions against the existing
-- schema. platform_support/platform_billing_admin gain nothing here: every
-- new/hardened function below still gates on
-- current_platform_role() = 'super_admin' specifically (service_role for
-- the scheduler function), exactly like every Super Admin RPC since
-- migration 17.

-- ---------------------------------------------------------------------------
-- 1. admin_change_subscription_state: hardened in place, same signature.
--
--    Admin-allowed transition matrix (from Phase 7B review, cross-checked
--    against packages/billing/src/stateMachine.ts's subscriptionTransitions
--    graph -- every edge below is a real edge in that graph; nothing here is
--    invented):
--
--      onboarding          -> trial               (start_trial)
--      onboarding          -> active               (activate)
--      onboarding          -> closed               (close)
--      trial               -> active               (activate)
--      trial               -> cancelled            (cancelled_immediately)
--      trial               -> closed               (close)
--      active              -> cancel_at_period_end (cancel_at_period_end_requested)
--      active              -> cancelled            (cancelled_immediately)
--      active              -> manually_suspended   (manual_suspend)
--      active              -> closed               (close)
--      payment_due         -> active               (payment_recovered)
--      payment_due         -> manually_suspended   (manual_suspend)
--      payment_due         -> cancelled            (cancelled_immediately)
--      payment_due         -> closed               (close)
--      grace_period        -> active               (payment_recovered)
--      grace_period        -> manually_suspended   (manual_suspend)
--      grace_period        -> cancelled            (cancelled_immediately)
--      grace_period        -> closed               (close)
--      suspended           -> active               (manual_reactivate)
--      suspended           -> cancelled            (cancelled_immediately)
--      suspended           -> closed               (close)
--      cancel_at_period_end -> active              (cancel_at_period_end_reversed)
--      cancel_at_period_end -> closed              (close)
--      cancelled           -> active               (activate)
--      cancelled           -> closed               (close)
--      manually_suspended  -> active               (manual_reactivate)
--      manually_suspended  -> cancelled            (cancelled_immediately)
--      manually_suspended  -> closed               (close)
--      closed              -> (anything)           FORBIDDEN, no exceptions
--
--    Deliberately rejected as automatic-only (real edges in the canonical
--    graph, but reserved for the scheduler/webhook paths that already own
--    them -- an admin forcing these bypasses real billing-cycle timing):
--      trial   -> payment_due   (trial_ended_without_payment)
--      active  -> payment_due   (payment_failed)
--      payment_due  -> grace_period   (grace_period_started)
--      grace_period -> suspended      (grace_period_expired)
--      cancel_at_period_end -> cancelled (period_ended_after_cancellation --
--        this is exactly what finalize_scheduled_subscription_cancellations
--        below now owns instead)
--
--    Ancillary-field behavior, keyed on the derived event (never on target
--    state alone, so e.g. plain 'activate' from onboarding/trial does not
--    fabricate a "reactivation" that never happened):
--      manual_suspend                 -> suspension_reason = p_reason
--      manual_reactivate               -> suspension_reason = null,
--                                          grace_period_end = null,
--                                          reactivated_at = now()
--      payment_recovered (admin-initiated) -> grace_period_end = null
--                                          (matches reconcile_razorpay_
--                                          payment's own behavior exactly)
--      cancelled_immediately           -> cancellation_reason = p_reason
--      cancel_at_period_end_requested  -> cancellation_reason = p_reason
--      cancel_at_period_end_reversed   -> cancellation_reason = null
--      activate                        -> cancellation_reason = null
--                                          (covers the cancelled -> active
--                                          win-back path cleanly; a harmless
--                                          no-op from onboarding/trial where
--                                          it is already null)
--      start_trial, close             -> no ancillary column touched
--    current_period_start/current_period_end are NEVER written by this
--    function under any transition -- no admin override here represents a
--    real payment event, so no billing period is ever fabricated or altered.
-- ---------------------------------------------------------------------------

create or replace function admin_change_subscription_state(p_company_id uuid, p_new_state subscription_state, p_reason text default null)
returns table (company_id uuid, state subscription_state)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions%rowtype;
  v_old_state public.subscription_state;
  v_event text;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;

  select * into v_sub from public.subscriptions where public.subscriptions.company_id = p_company_id for update;
  if not found then raise exception 'subscription_not_found'; end if;

  -- Always resolve the current state from the row just locked -- never from
  -- any value the caller might have read earlier (there is no "expected
  -- current state" parameter to this function; the FOR UPDATE lock plus this
  -- fresh read is what makes a concurrent scheduler/webhook transition safe
  -- to race against: whichever writer acquires the lock first wins, and the
  -- other re-validates against the row's real state once it gets the lock).
  v_old_state := v_sub.state;

  v_event := case
    when v_old_state = 'onboarding' and p_new_state = 'trial' then 'start_trial'
    when v_old_state = 'onboarding' and p_new_state = 'active' then 'activate'
    when v_old_state = 'onboarding' and p_new_state = 'closed' then 'close'
    when v_old_state = 'trial' and p_new_state = 'active' then 'activate'
    when v_old_state = 'trial' and p_new_state = 'cancelled' then 'cancelled_immediately'
    when v_old_state = 'trial' and p_new_state = 'closed' then 'close'
    when v_old_state = 'active' and p_new_state = 'cancel_at_period_end' then 'cancel_at_period_end_requested'
    when v_old_state = 'active' and p_new_state = 'cancelled' then 'cancelled_immediately'
    when v_old_state = 'active' and p_new_state = 'manually_suspended' then 'manual_suspend'
    when v_old_state = 'active' and p_new_state = 'closed' then 'close'
    when v_old_state = 'payment_due' and p_new_state = 'active' then 'payment_recovered'
    when v_old_state = 'payment_due' and p_new_state = 'manually_suspended' then 'manual_suspend'
    when v_old_state = 'payment_due' and p_new_state = 'cancelled' then 'cancelled_immediately'
    when v_old_state = 'payment_due' and p_new_state = 'closed' then 'close'
    when v_old_state = 'grace_period' and p_new_state = 'active' then 'payment_recovered'
    when v_old_state = 'grace_period' and p_new_state = 'manually_suspended' then 'manual_suspend'
    when v_old_state = 'grace_period' and p_new_state = 'cancelled' then 'cancelled_immediately'
    when v_old_state = 'grace_period' and p_new_state = 'closed' then 'close'
    when v_old_state = 'suspended' and p_new_state = 'active' then 'manual_reactivate'
    when v_old_state = 'suspended' and p_new_state = 'cancelled' then 'cancelled_immediately'
    when v_old_state = 'suspended' and p_new_state = 'closed' then 'close'
    when v_old_state = 'cancel_at_period_end' and p_new_state = 'active' then 'cancel_at_period_end_reversed'
    when v_old_state = 'cancel_at_period_end' and p_new_state = 'closed' then 'close'
    when v_old_state = 'cancelled' and p_new_state = 'active' then 'activate'
    when v_old_state = 'cancelled' and p_new_state = 'closed' then 'close'
    when v_old_state = 'manually_suspended' and p_new_state = 'active' then 'manual_reactivate'
    when v_old_state = 'manually_suspended' and p_new_state = 'cancelled' then 'cancelled_immediately'
    when v_old_state = 'manually_suspended' and p_new_state = 'closed' then 'close'
    else null
  end;

  -- Covers every automatic-only edge, every genuinely forbidden edge
  -- (including the four the Phase 7B review explicitly enumerated: closed ->
  -- trial, suspended -> trial, active -> onboarding, grace_period -> trial),
  -- any same-state no-op, and closed -> anything (closed never appears as a
  -- when-clause source above, so it always falls through here).
  if v_event is null then
    raise exception 'invalid_state_transition';
  end if;

  update public.subscriptions
    set state = p_new_state,
        suspension_reason = case v_event
          when 'manual_suspend' then p_reason
          when 'manual_reactivate' then null
          else suspension_reason
        end,
        cancellation_reason = case v_event
          when 'cancelled_immediately' then p_reason
          when 'cancel_at_period_end_requested' then p_reason
          when 'cancel_at_period_end_reversed' then null
          when 'activate' then null
          else cancellation_reason
        end,
        grace_period_end = case v_event
          when 'manual_reactivate' then null
          when 'payment_recovered' then null
          else grace_period_end
        end,
        reactivated_at = case v_event
          when 'manual_reactivate' then now()
          else reactivated_at
        end
    where public.subscriptions.company_id = p_company_id
    returning * into v_sub;

  insert into public.subscription_events (company_id, subscription_id, from_state, to_state, event, is_manual_override, actor_user_id, notes)
    values (p_company_id, v_sub.id, v_old_state, p_new_state, v_event, true, auth.uid(), p_reason);

  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user',
            case v_event
              when 'cancel_at_period_end_requested' then 'subscription_cancel_scheduled'
              when 'cancel_at_period_end_reversed' then 'subscription_cancel_reversed'
              when 'cancelled_immediately' then 'subscription_cancelled'
              when 'manual_suspend' then 'subscription_manually_suspended'
              when 'manual_reactivate' then 'subscription_reactivated'
              else 'subscription_changed'
            end,
            'subscription', v_sub.id::text,
            jsonb_build_object('from_state', v_old_state, 'to_state', p_new_state, 'event', v_event, 'reason', p_reason));

  return query select v_sub.company_id, v_sub.state;
end;
$$;

comment on function admin_change_subscription_state(uuid, subscription_state, text) is
  'Phase 7B: hardened in place (same signature as migration 17). Validates the requested (old_state, new_state) pair against the exact admin-allowed edge set derived from packages/billing/src/stateMachine.ts, rejects every automatic-only/forbidden edge and everything out of the terminal closed state, derives the correct canonical subscription_events.event server-side (never trusts a client-supplied event name), and updates only the ancillary columns (suspension_reason/cancellation_reason/grace_period_end/reactivated_at) each specific transition genuinely requires -- current_period_start/current_period_end are never touched, since no admin override here represents a real payment event.';

revoke all on function admin_change_subscription_state(uuid, subscription_state, text) from public, anon;
grant execute on function admin_change_subscription_state(uuid, subscription_state, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. admin_reset_company_entitlement: restores plan-default behavior for one
--    feature by deleting the company-specific override row. plan_entitlements
--    is never touched -- entitlementGuard's existing merge (packages/billing)
--    already falls back to the plan's own value once no company_entitlements
--    row exists for that (company_id, feature_key) pair, so deletion alone is
--    both necessary and sufficient; no compensating write is needed anywhere
--    else.
-- ---------------------------------------------------------------------------

create or replace function admin_reset_company_entitlement(p_company_id uuid, p_feature_key text, p_reason text default null)
returns table (company_id uuid, feature_key text, had_override boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer;
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if public.current_platform_role() is distinct from 'super_admin' then raise exception 'permission_denied'; end if;

  if not exists (select 1 from public.companies where public.companies.id = p_company_id) then
    raise exception 'company_not_found';
  end if;
  if p_feature_key is null or length(trim(p_feature_key)) = 0 then raise exception 'invalid_feature_key'; end if;

  delete from public.company_entitlements
    where public.company_entitlements.company_id = p_company_id
      and public.company_entitlements.feature_key = p_feature_key;
  get diagnostics v_deleted_count = row_count;

  -- Always audited, even when there was nothing to reset -- the attempted
  -- administrative action itself must stay observable, matching the Phase
  -- 7B review's explicit preference.
  insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
    values (p_company_id, auth.uid(), 'user', 'entitlement_reset', 'company_entitlement', p_feature_key,
            jsonb_build_object('feature_key', p_feature_key, 'reason', p_reason, 'had_override', v_deleted_count > 0));

  return query select p_company_id, p_feature_key, (v_deleted_count > 0);
end;
$$;

comment on function admin_reset_company_entitlement(uuid, text, text) is
  'Phase 7B: deletes exactly the (company_id, feature_key) row from company_entitlements, restoring inheritance from plan_entitlements via entitlementGuard''s existing merge. Idempotent (deleting an already-absent override is a safe no-op) and always audited, including the no-op case, so the attempted action stays observable. Never touches plan_entitlements and never copies a plan default into company_entitlements.';

revoke all on function admin_reset_company_entitlement(uuid, text, text) from public, anon;
grant execute on function admin_reset_company_entitlement(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. finalize_scheduled_subscription_cancellations: closes the
--    cancel_at_period_end -> cancelled automation gap. service_role only,
--    same shape as suspend_expired_grace_subscriptions (migration 30). Never
--    touches invoices/payments, and only ever reads/writes subscriptions
--    already in cancel_at_period_end whose current_period_end has passed --
--    every other subscription state is structurally excluded by the WHERE
--    clause, not just by convention.
-- ---------------------------------------------------------------------------

create or replace function finalize_scheduled_subscription_cancellations()
returns table (company_id uuid, subscription_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub record;
begin
  for v_sub in
    select s.id as subscription_id, s.company_id
    from public.subscriptions s
    where s.state = 'cancel_at_period_end'
      and s.current_period_end is not null
      and s.current_period_end < now()
    for update of s
  loop
    update public.subscriptions set state = 'cancelled' where id = v_sub.subscription_id;

    insert into public.subscription_events (company_id, subscription_id, from_state, to_state, event, is_manual_override, actor_user_id, notes)
      values (v_sub.company_id, v_sub.subscription_id, 'cancel_at_period_end', 'cancelled', 'period_ended_after_cancellation', false, null,
              'scheduler: scheduled-cancellation period ended');

    insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
      values (v_sub.company_id, null, 'system', 'subscription_cancelled', 'subscription', v_sub.subscription_id::text, '{}'::jsonb);

    company_id := v_sub.company_id;
    subscription_id := v_sub.subscription_id;
    return next;
  end loop;
end;
$$;

comment on function finalize_scheduled_subscription_cancellations() is
  'Phase 7B: transitions any subscription scheduled for cancel_at_period_end whose current_period_end has actually passed into cancelled (period_ended_after_cancellation), closing an automation gap that predates this migration -- previously nothing ever completed a scheduled cancellation automatically. Never touches active/trial/payment_due/grace_period/suspended/manually_suspended/cancelled/closed/onboarding subscriptions, and never mutates invoices/payments. Idempotent: re-running finds no cancel_at_period_end subscriptions with an already-passed period once this has run once.';

revoke all on function finalize_scheduled_subscription_cancellations() from public, anon, authenticated;
grant execute on function finalize_scheduled_subscription_cancellations() to service_role;
