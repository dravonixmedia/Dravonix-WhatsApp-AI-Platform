import type { SubscriptionEvent } from "../../stateMachine.js";

/**
 * Translates a Razorpay subscription/payment webhook event name into an
 * internal SubscriptionEvent (ADR-0006). This is the ONLY place in the codebase
 * that knows Razorpay's event vocabulary -- everything downstream works with the
 * internal state machine only.
 *
 * Returns null for events that are informational and require no state
 * transition (the caller should record them to subscription_events/payment_attempts
 * for observability but not attempt to apply a transition).
 */
export function mapRazorpayEventToSubscriptionEvent(
  razorpayEvent: string,
): SubscriptionEvent | null {
  switch (razorpayEvent) {
    case "subscription.authenticated":
    case "subscription.activated":
      return "activate";
    case "subscription.charged":
      return "payment_recovered";
    case "subscription.pending":
    case "payment.failed":
      return "payment_failed";
    case "subscription.halted":
      // Razorpay's own halt semantics are not authoritative for our grace
      // period timing (ADR-0006) -- treat a halt as another payment failure
      // signal and let our own grace-period cron job decide when to suspend.
      return "payment_failed";
    case "subscription.paused":
      return "manual_suspend";
    case "subscription.resumed":
      return "manual_reactivate";
    case "subscription.cancelled":
      return "cancelled_immediately";
    case "subscription.completed":
      return "period_ended_after_cancellation";
    default:
      return null;
  }
}
