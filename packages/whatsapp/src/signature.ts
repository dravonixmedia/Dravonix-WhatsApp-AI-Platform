import { hmacSha256Hex, timingSafeEqualHex } from "@dravonix/core";

const SIGNATURE_PREFIX = "sha256=";

/**
 * Verifies Meta's `X-Hub-Signature-256` header (format: `sha256=<hex>`) against
 * the exact raw request body, using META_APP_SECRET. Must run before any JSON
 * parsing of the webhook body -- see ADR-0002. Returns false (never throws) for
 * any malformed input so callers can uniformly respond 401.
 */
export async function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith(SIGNATURE_PREFIX)) return false;
  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length).toLowerCase();
  const expectedHex = await hmacSha256Hex(appSecret, rawBody);
  return timingSafeEqualHex(expectedHex, providedHex);
}

/**
 * Verifies Meta's webhook verification handshake (`GET` request with
 * `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`). Returns the
 * challenge string to echo back, or null if verification fails.
 */
export function verifyMetaWebhookChallenge(
  query: { mode: string | null; verifyToken: string | null; challenge: string | null },
  expectedVerifyToken: string,
): string | null {
  if (query.mode !== "subscribe") return null;
  if (!query.verifyToken || query.verifyToken !== expectedVerifyToken) return null;
  return query.challenge;
}
