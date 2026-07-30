import { InvalidStateTransitionError } from "@dravonix/core";

/**
 * Internal, provider-independent subscription state machine (ADR-0006, Master
 * Prompt section 21). Razorpay/manual-payment events are translated into these
 * events by packages/billing/src/providers/*; nothing else in the app ever reads
 * a provider-specific status to decide entitlement.
 */
export type SubscriptionState =
  | "onboarding"
  | "trial"
  | "active"
  | "payment_due"
  | "grace_period"
  | "suspended"
  | "cancel_at_period_end"
  | "cancelled"
  | "manually_suspended"
  | "closed";

export type SubscriptionEvent =
  | "start_trial"
  | "activate"
  | "trial_ended_without_payment"
  | "payment_failed"
  | "grace_period_started"
  | "payment_recovered"
  | "grace_period_expired"
  | "manual_suspend"
  | "manual_reactivate"
  | "cancel_at_period_end_requested"
  | "cancel_at_period_end_reversed"
  | "period_ended_after_cancellation"
  | "cancelled_immediately"
  | "close";

type Transitions = Record<SubscriptionState, Partial<Record<SubscriptionEvent, SubscriptionState>>>;

export const subscriptionTransitions: Transitions = {
  onboarding: {
    start_trial: "trial",
    activate: "active",
    close: "closed",
  },
  trial: {
    activate: "active",
    trial_ended_without_payment: "payment_due",
    cancelled_immediately: "cancelled",
    close: "closed",
  },
  active: {
    payment_failed: "payment_due",
    // A recurring renewal charge succeeding while already active is the normal
    // monthly case, not just webhook-duplicate idempotency -- keep it a self-loop.
    payment_recovered: "active",
    cancel_at_period_end_requested: "cancel_at_period_end",
    cancelled_immediately: "cancelled",
    manual_suspend: "manually_suspended",
    close: "closed",
  },
  payment_due: {
    payment_recovered: "active",
    grace_period_started: "grace_period",
    manual_suspend: "manually_suspended",
    cancelled_immediately: "cancelled",
    close: "closed",
  },
  grace_period: {
    payment_recovered: "active",
    grace_period_expired: "suspended",
    manual_suspend: "manually_suspended",
    cancelled_immediately: "cancelled",
    close: "closed",
  },
  suspended: {
    payment_recovered: "active",
    manual_reactivate: "active",
    cancelled_immediately: "cancelled",
    close: "closed",
  },
  cancel_at_period_end: {
    cancel_at_period_end_reversed: "active",
    period_ended_after_cancellation: "cancelled",
    close: "closed",
  },
  cancelled: {
    activate: "active",
    close: "closed",
  },
  manually_suspended: {
    manual_reactivate: "active",
    cancelled_immediately: "cancelled",
    close: "closed",
  },
  closed: {},
};

export function applySubscriptionEvent(
  currentState: SubscriptionState,
  event: SubscriptionEvent,
): SubscriptionState {
  const nextState = subscriptionTransitions[currentState][event];
  if (!nextState) {
    throw new InvalidStateTransitionError(currentState, event);
  }
  return nextState;
}

/**
 * States in which the company must be blocked from any chargeable operation
 * (Claude, STT, TTS, WhatsApp send, knowledge ingestion) -- Master Prompt
 * sections 22-23. `trial`/`onboarding` are intentionally NOT blocked here; a
 * trial is expected to use the product, and onboarding-stage entitlement is
 * governed separately by whether WhatsApp/knowledge setup is complete.
 */
export const SERVICE_BLOCKED_STATES: ReadonlySet<SubscriptionState> = new Set([
  "suspended",
  "manually_suspended",
  "cancelled",
  "closed",
]);

export function isServiceBlocked(state: SubscriptionState): boolean {
  return SERVICE_BLOCKED_STATES.has(state);
}
