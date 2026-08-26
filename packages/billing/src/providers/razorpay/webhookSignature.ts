import { hmacSha256Hex, timingSafeEqualHex } from "@dravonix/core";

/**
 * Verifies a Razorpay webhook's `X-Razorpay-Signature` header (a raw
 * hex-encoded HMAC-SHA256 digest of the exact raw request body, no `sha256=`
 * prefix) against RAZORPAY_WEBHOOK_SECRET. Must run on the raw request body
 * before any JSON parsing (Master Prompt section 24: reject invalid signatures,
 * never trust frontend payment-success parameters alone).
 */
export async function verifyRazorpayWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  webhookSecret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const expected = await hmacSha256Hex(webhookSecret, rawBody);
  return timingSafeEqualHex(expected, signatureHeader.toLowerCase());
}

/**
 * Verifies a Razorpay Checkout success callback's `razorpay_signature`
 * (HMAC-SHA256 of `"{order_id}|{payment_id}"`, keyed by RAZORPAY_KEY_SECRET
 * -- a different secret and payload shape than the webhook signature above,
 * but the same HMAC/timing-safe-compare primitives from @dravonix/core, so
 * this reuses them rather than introducing a second crypto implementation).
 *
 * A true result here is only proof the browser is relaying a genuinely
 * Razorpay-signed completion -- it is NOT proof of payment and must never
 * by itself flip any payment/invoice/subscription state. That only ever
 * happens in reconcile_razorpay_payment (service_role, webhook-driven);
 * this function exists purely to give the client fast, honest UI feedback
 * ("Razorpay confirms this looks real, waiting for confirmation") while the
 * webhook -- which Razorpay retries and which this app processes
 * idempotently -- is the sole source of truth for state changes.
 */
export async function verifyRazorpayPaymentSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  signature: string | null | undefined,
  keySecret: string,
): Promise<boolean> {
  if (!signature) return false;
  const payload = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expected = await hmacSha256Hex(keySecret, payload);
  return timingSafeEqualHex(expected, signature.toLowerCase());
}
