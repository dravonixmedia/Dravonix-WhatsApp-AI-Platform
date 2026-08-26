export interface RazorpayPaymentWebhookEvent {
  /** Dedup key for payment_attempts' unique(provider, provider_event_id) -- Razorpay has no single top-level event id for this event family, so this is derived from the event name + payment id, which together are unique per real occurrence. */
  eventId: string;
  status: "captured" | "failed";
  orderId: string;
  paymentId: string;
  /**
   * Smallest currency unit (e.g. paise for INR), exactly as Razorpay's
   * payment entity represents it -- never converted/normalized here.
   * reconcile_razorpay_payment compares this against the internal payment
   * row's own amount (converted via the same rule as
   * packages/billing/src/providers/razorpay/currency.ts) before ever
   * marking a payment succeeded, so a captured amount that doesn't match
   * what was actually billed can never silently reconcile.
   */
  amountInSmallestUnit: number;
  /** Razorpay's own currency code for this payment entity, exactly as received -- not case-normalized here (the comparison site normalizes both sides). */
  currency: string;
}

/**
 * Parses a Razorpay `payment.captured`/`payment.failed` webhook payload into
 * the minimal shape reconcile_razorpay_payment needs. Deliberately separate
 * from eventMapper.ts: that file maps `subscription.*` events for a future
 * Razorpay Subscriptions integration (not built -- Phase 6B uses one-time
 * Orders + Checkout only, per ADR-0006's own principle that Razorpay is
 * never the authorization source of truth). Returns null for any other
 * event (including `order.paid`, informational, or a stray subscription.*
 * event) -- the webhook handler acknowledges those without attempting
 * reconciliation, since there is nothing this endpoint's scope covers to do
 * with them.
 *
 * Also returns null for a payment entity missing a positive amount or a
 * non-empty currency -- a genuine Razorpay payment entity always carries
 * both, so their absence is itself a signal of a malformed/untrustworthy
 * payload, rejected here for the same reason a missing id/order_id is.
 */
export function parseRazorpayPaymentWebhookEvent(
  payload: unknown,
): RazorpayPaymentWebhookEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const event = body.event;
  if (event !== "payment.captured" && event !== "payment.failed") return null;

  const paymentContainer = (body.payload as Record<string, unknown> | undefined)?.payment as
    Record<string, unknown> | undefined;
  const entity = paymentContainer?.entity as Record<string, unknown> | undefined;
  const paymentId = entity?.id;
  const orderId = entity?.order_id;
  const amount = entity?.amount;
  const currency = entity?.currency;
  if (typeof paymentId !== "string" || typeof orderId !== "string") return null;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  if (typeof currency !== "string" || currency.trim() === "") return null;

  return {
    eventId: `${event}:${paymentId}`,
    status: event === "payment.captured" ? "captured" : "failed",
    orderId,
    paymentId,
    amountInSmallestUnit: amount,
    currency,
  };
}
