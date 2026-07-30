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
