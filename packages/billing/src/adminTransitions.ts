import type { SubscriptionState } from "./stateMachine.js";

/**
 * Phase 7B: the subset of stateMachine.ts's own subscriptionTransitions
 * graph that a Super Admin may invoke directly via
 * admin_change_subscription_state (supabase/migrations/00000000000032_super_admin_subscription_controls.sql).
 * Every target listed below is a real edge in subscriptionTransitions --
 * this is strictly a narrowing, never an addition. Automatic-only edges
 * (trial_ended_without_payment, payment_failed, grace_period_started,
 * grace_period_expired, period_ended_after_cancellation) are deliberately
 * excluded: the scheduler/webhook paths already own them, and an admin
 * forcing one bypasses real billing-cycle timing. `closed` has an empty
 * target list by design -- no outgoing admin transition ever exists from
 * closed, matching the canonical graph's own empty transition set for that
 * state exactly.
 *
 * This is presentation-layer data only (which targets a UI may offer as
 * buttons/options) -- migration 32's own admin_change_subscription_state
 * independently re-validates every request server-side using the same
 * edge set, and is the actual authority. A UI that shows a target not in
 * this list would simply have its request rejected with
 * `invalid_state_transition`; nothing here is a security boundary.
 */
export const ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS: Readonly<
  Record<SubscriptionState, readonly SubscriptionState[]>
> = {
  onboarding: ["trial", "active", "closed"],
  trial: ["active", "cancelled", "closed"],
  active: ["cancel_at_period_end", "cancelled", "manually_suspended", "closed"],
  payment_due: ["active", "manually_suspended", "cancelled", "closed"],
  grace_period: ["active", "manually_suspended", "cancelled", "closed"],
  suspended: ["active", "cancelled", "closed"],
  cancel_at_period_end: ["active", "closed"],
  cancelled: ["active", "closed"],
  manually_suspended: ["active", "cancelled", "closed"],
  closed: [],
};

export function adminAllowedTransitionTargets(
  currentState: SubscriptionState,
): readonly SubscriptionState[] {
  return ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS[currentState];
}
