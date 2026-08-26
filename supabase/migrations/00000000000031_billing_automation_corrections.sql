-- Dravonix WhatsApp AI Platform
-- Phase 6C: Migration 31 -- corrections to Migration 30's billing automation
-- foundation, found during staging verification. Migration 30 is immutable
-- and is never touched here -- every fix below is a plain
-- `create or replace function` (or a targeted `revoke`), built forward.
--
-- Three corrections, each independently minimal:
--
--   1. advance_overdue_subscriptions' "is this cycle already paid?" check
--      compared subscriptions.current_period_end's UTC calendar date against
--      invoices.billing_period_end, but generate_due_subscription_invoices
--      always records billing_period_end using the company's LOCAL calendar
--      date (via companies.timezone). For a non-UTC company whose period end
--      falls in the window where the UTC and local calendar dates differ,
--      an already-paid invoice was not recognized, and the subscription was
--      wrongly advanced payment_due -> grace_period. Reproduced directly on
--      hosted staging with an Asia/Kolkata fixture (see the Phase 6C
--      verification report). Fixed by joining companies into
--      advance_overdue_subscriptions and using the exact same
--      `(timestamptz at time zone coalesce(companies.timezone, 'UTC'))::date`
--      conversion generate_due_subscription_invoices already uses -- no new
--      conversion formula is invented, and companies.timezone is never
--      mutated, nor is any invoice date.
--
--   2. send_due_billing_reminders had no subscription-state guard at all: a
--      pending subscription invoice left over from before a company
--      cancelled would still be classified and reminded. Invoice generation
--      and state advancement already correctly restrict themselves to
--      trial/active (generation) and trial/active (advancement source
--      states) -- reminders must respect the same billing-lifecycle
--      boundary. The allowed set is derived here, not guessed: it is every
--      subscription_state that is NOT one of the four states
--      packages/billing/src/stateMachine.ts's own SERVICE_BLOCKED_STATES
--      already treats as "this company is not a live billing relationship"
--      (suspended, manually_suspended, cancelled, closed), plus `onboarding`
--      (no plan/pricing is active yet -- generate_due_subscription_invoices
--      never produces an invoice for it either). That leaves
--      {trial, active, payment_due, grace_period, cancel_at_period_end} as
--      the states a reminder may ever fire for --
--      cancel_at_period_end is deliberately included: per stateMachine.ts,
--      it is not service-blocked and remains fully billable up to its
--      current period end (only period_ended_after_cancellation moves it to
--      the blocked `cancelled` state), so its pending final-cycle invoice
--      must keep receiving due-date reminders exactly like `active`.
--
--   3. billing_invoice_number_seq still carried this project's ordinary
--      default-privilege grant of USAGE/SELECT/UPDATE to anon/authenticated
--      (confirmed via `pg_class.relacl` against hosted staging) -- every
--      other object Migration 30 introduced was explicitly hardened, but the
--      sequence was not. Not believed directly exploitable (PostgREST/the
--      JS client never expose raw nextval()/setval() calls), but unnecessary
--      and inconsistent with the rest of the migration's hardening.
--      generate_due_subscription_invoices is SECURITY DEFINER and owned by
--      `postgres` -- confirmed via `pg_class.relowner` that the sequence is
--      also owned by `postgres` -- so the function's own access to the
--      sequence comes from object ownership, not from anon/authenticated's
--      grant, and is completely unaffected by revoking those two roles.

-- ---------------------------------------------------------------------------
-- 1. advance_overdue_subscriptions: company-local (not UTC) cycle-date
--    comparison, matching generate_due_subscription_invoices exactly.
-- ---------------------------------------------------------------------------

create or replace function advance_overdue_subscriptions()
returns table (company_id uuid, subscription_id uuid, new_state subscription_state)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub record;
  v_due_event text;
  v_grace_days integer;
  v_grace_period_end timestamptz;
begin
  for v_sub in
    select s.id as subscription_id, s.company_id, s.state, s.current_period_end, pv.grace_period_days
    from public.subscriptions s
    join public.plan_versions pv on pv.id = s.plan_version_id
    join public.companies c on c.id = s.company_id
    where s.state in ('trial', 'active')
      and s.current_period_end is not null
      and s.current_period_end < now()
      and not exists (
        select 1 from public.invoices i
        where i.company_id = s.company_id
          and i.kind = 'subscription'
          and i.billing_period_end = (s.current_period_end at time zone coalesce(c.timezone, 'UTC'))::date
          and i.status = 'paid'
      )
    for update of s
  loop
    v_due_event := case v_sub.state when 'trial' then 'trial_ended_without_payment' else 'payment_failed' end;
    v_grace_days := v_sub.grace_period_days;
    -- Grace period counts from the actual lapse (current_period_end), never
    -- from "now" (the moment the scheduler happens to process it) -- a
    -- delayed/backfilled scheduler run must never grant a subscription
    -- bonus grace time it wouldn't have had if the scheduler had run daily
    -- without interruption. Mirrors computeGracePeriodEnd's own
    -- (startedAt, gracePeriodDays) contract exactly, with startedAt =
    -- current_period_end. Unchanged from migration 30.
    v_grace_period_end := v_sub.current_period_end + make_interval(days => v_grace_days);

    update public.subscriptions set state = 'payment_due' where id = v_sub.subscription_id;

    insert into public.subscription_events (company_id, subscription_id, from_state, to_state, event, is_manual_override, actor_user_id, notes)
      values (v_sub.company_id, v_sub.subscription_id, v_sub.state, 'payment_due', v_due_event, false, null,
              'scheduler: current billing period ended without a paid invoice');

    update public.subscriptions
      set state = 'grace_period', grace_period_end = v_grace_period_end
      where id = v_sub.subscription_id;

    insert into public.subscription_events (company_id, subscription_id, from_state, to_state, event, is_manual_override, actor_user_id, notes)
      values (v_sub.company_id, v_sub.subscription_id, 'payment_due', 'grace_period', 'grace_period_started', false, null,
              'scheduler: grace period of ' || v_grace_days || ' day(s) per plan');

    insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
      values (v_sub.company_id, null, 'system', 'payment_due', 'subscription', v_sub.subscription_id::text,
              jsonb_build_object('from_state', v_sub.state));
    insert into public.audit_logs (company_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
      values (v_sub.company_id, null, 'system', 'grace_period_started', 'subscription', v_sub.subscription_id::text,
              jsonb_build_object('grace_period_end', v_grace_period_end, 'grace_period_days', v_grace_days));

    company_id := v_sub.company_id;
    subscription_id := v_sub.subscription_id;
    new_state := 'grace_period';
    return next;
  end loop;
end;
$$;

comment on function advance_overdue_subscriptions() is
  'Phase 6C (corrected by migration 31): transitions any trial/active subscription whose current_period_end has passed with its cycle invoice still unpaid through payment_due (trial_ended_without_payment or payment_failed, matching the real prior state) and immediately into grace_period (grace_period_started), using plan_versions.grace_period_days via the exact arithmetic packages/billing/src/gracePeriod.ts already defines. The already-paid check now compares company-LOCAL calendar dates on both sides (matching generate_due_subscription_invoices exactly) instead of comparing a UTC date against a local-date invoice column -- migration 30''s original UTC-only comparison could wrongly treat an already-paid non-UTC company as unpaid. Idempotent: re-running finds no subscriptions still in trial/active with a lapsed period once this has run once (the WHERE clause naturally excludes anything already in payment_due/grace_period/suspended).';

revoke all on function advance_overdue_subscriptions() from public, anon, authenticated;
grant execute on function advance_overdue_subscriptions() to service_role;

-- ---------------------------------------------------------------------------
-- 2. send_due_billing_reminders: restrict reminder candidates to subscription
--    states that are actually part of a live, non-blocked billing cycle.
-- ---------------------------------------------------------------------------

create or replace function send_due_billing_reminders()
returns table (company_id uuid, invoice_id uuid, stage billing_reminder_stage)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_stage public.billing_reminder_stage;
  v_days_remaining integer;
  v_local_today date;
  v_subject text;
  v_body text;
begin
  for v_row in
    select i.id as invoice_id, i.company_id, i.invoice_number, i.total, i.currency, i.due_date,
           s.state as subscription_state, c.timezone, c.name as company_name
    from public.invoices i
    join public.companies c on c.id = i.company_id
    left join public.subscriptions s on s.company_id = i.company_id
    where i.kind = 'subscription' and i.status = 'pending'
  loop
    -- Reminders only ever fire for a subscription still inside a live,
    -- non-blocked billing cycle: trial (first invoice before conversion),
    -- active, payment_due, grace_period, and cancel_at_period_end (still
    -- fully billable up to its current period end -- see the migration
    -- header for why it is deliberately included). Every other state --
    -- onboarding (no plan/pricing active yet), and the four states
    -- packages/billing/src/stateMachine.ts's own SERVICE_BLOCKED_STATES
    -- already treats as blocked (suspended, manually_suspended, cancelled,
    -- closed) -- must never receive a reminder for a stale leftover
    -- invoice. A null subscription_state (no subscription row at all) is
    -- excluded by the same check.
    if v_row.subscription_state is null
       or v_row.subscription_state not in ('trial', 'active', 'payment_due', 'grace_period', 'cancel_at_period_end') then
      continue;
    end if;

    v_local_today := (now() at time zone coalesce(v_row.timezone, 'UTC'))::date;
    v_days_remaining := v_row.due_date - v_local_today;

    if v_row.subscription_state = 'grace_period' then
      v_stage := 'grace_period_started';
    elsif v_days_remaining <= 0 then
      v_stage := 'due_today';
    elsif v_days_remaining = 1 then
      v_stage := 'due_in_1';
    elsif v_days_remaining = 3 then
      v_stage := 'due_in_3';
    elsif v_days_remaining = 7 then
      v_stage := 'due_in_7';
    else
      continue;
    end if;

    v_subject := 'Invoice ' || v_row.invoice_number || ' -- ' ||
      case v_stage
        when 'due_in_7' then 'due in 7 days'
        when 'due_in_3' then 'due in 3 days'
        when 'due_in_1' then 'due tomorrow'
        when 'due_today' then 'due today'
        when 'grace_period_started' then 'payment overdue, grace period active'
      end;
    v_body := v_row.company_name || ': invoice ' || v_row.invoice_number || ' for ' ||
      v_row.currency || ' ' || v_row.total || ' is due ' || v_row.due_date || '.';

    begin
      insert into public.billing_reminders (company_id, invoice_id, stage, channel)
        values (v_row.company_id, v_row.invoice_id, v_stage, 'in_app');

      insert into public.notifications (company_id, audience, channel, recipient_user_id, category, subject, body, sent_at)
        values (v_row.company_id, 'company_admin', 'in_app', null,
                case v_stage when 'grace_period_started' then 'grace_period_started' else 'renewal_upcoming' end,
                v_subject, v_body, now());

      company_id := v_row.company_id;
      invoice_id := v_row.invoice_id;
      stage := v_stage;
      return next;
    exception when unique_violation then
      -- This exact (invoice, stage, channel) reminder was already sent by
      -- an earlier or overlapping run -- safe no-op, nothing double-sent.
      continue;
    end;
  end loop;
end;
$$;

comment on function send_due_billing_reminders() is
  'Phase 6C (corrected by migration 31): for every pending subscription invoice whose subscription is in a live, non-blocked billing state (trial, active, payment_due, grace_period, cancel_at_period_end -- see migration 31''s header for the exact derivation), computes the company-local days-remaining-until-due (or detects an active grace period) and, at most once per (invoice, stage) via billing_reminders'' unique constraint, records the reminder and creates a company-wide (recipient_user_id null, visible to any member with billing.view via notifications'' existing RLS policy) in_app notifications row. No email is ever sent from this function -- see migration 30''s header comment for why.';

revoke all on function send_due_billing_reminders() from public, anon, authenticated;
grant execute on function send_due_billing_reminders() to service_role;

-- ---------------------------------------------------------------------------
-- 3. billing_invoice_number_seq: remove the ordinary default-privilege grant
--    to anon/authenticated. generate_due_subscription_invoices is SECURITY
--    DEFINER and owned by `postgres`, which also owns this sequence, so its
--    own nextval() access comes from object ownership and is unaffected.
-- ---------------------------------------------------------------------------

revoke all on sequence public.billing_invoice_number_seq from public, anon, authenticated;

comment on sequence billing_invoice_number_seq is
  'Backs the DRV-<year>-<6 digits> invoice number format (Phase 6C). A real Postgres sequence is used specifically because it is safe under arbitrary concurrency by construction -- no advisory lock or row lock is needed to avoid a collision. Test/demo fixtures (e.g. INV-STAGING-TEST-0001) are unrelated hand-authored strings and never collide with this format. anon/authenticated privileges revoked by migration 31 -- only generate_due_subscription_invoices (SECURITY DEFINER, owned by the same role that owns this sequence) ever calls nextval() on it.';
