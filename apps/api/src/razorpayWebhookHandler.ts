import {
  parseRazorpayPaymentWebhookEvent,
  verifyRazorpayWebhookSignature,
} from "@dravonix/billing";
import type { Logger } from "@dravonix/observability";
import type { RazorpayPaymentRepository } from "./repositories/razorpayPaymentRepository.js";

export interface RazorpayWebhookDeps {
  webhookSecret: string;
  repo: RazorpayPaymentRepository;
  logger: Logger;
}

export interface HttpResult {
  status: number;
  body: string;
}

/**
 * POST /webhooks/razorpay. Verifies the signature over the raw body first
 * (Master Prompt section 24 / ADR-0006: never trust an unsigned payload,
 * and the client Checkout callback is only ever a fast-feedback signal --
 * this webhook is the sole place a payment/invoice/subscription actually
 * transitions, via reconcile_razorpay_payment). Events other than
 * payment.captured/payment.failed (order.paid, any future subscription.*
 * event once Razorpay Subscriptions work begins) are acknowledged but not
 * processed -- this endpoint's scope is exactly the one-time
 * Orders+Checkout flow Phase 6B implements.
 */
export async function handleRazorpayWebhookPost(
  deps: RazorpayWebhookDeps,
  rawBody: string,
  signatureHeader: string | null,
): Promise<HttpResult> {
  const validSignature = await verifyRazorpayWebhookSignature(
    rawBody,
    signatureHeader,
    deps.webhookSecret,
  );
  if (!validSignature) {
    deps.logger.warn("Rejected Razorpay webhook: invalid signature");
    return { status: 401, body: "invalid signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    deps.logger.error("Failed to parse Razorpay webhook payload", { error: String(error) });
    return { status: 200, body: "ok" };
  }

  const event = parseRazorpayPaymentWebhookEvent(payload);
  if (!event) {
    // Verified but not a payment.captured/payment.failed event -- nothing
    // for this endpoint to reconcile; ack so Razorpay doesn't retry.
    return { status: 200, body: "ok" };
  }

  await deps.repo.reconcilePayment({
    providerEventId: event.eventId,
    eventStatus: event.status,
    razorpayOrderId: event.orderId,
    razorpayPaymentId: event.paymentId,
    amountInSmallestUnit: event.amountInSmallestUnit,
    currency: event.currency,
    rawPayload: payload,
  });

  return { status: 200, body: "ok" };
}
