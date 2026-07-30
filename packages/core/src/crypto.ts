/**
 * Portable HMAC-SHA256 helpers built on the Web Crypto API (available as
 * `globalThis.crypto.subtle` in both Node.js 20+ and the Cloudflare Workers
 * runtime), so webhook signature verification code works unmodified in
 * apps/api whether it runs locally under Node or deployed to Workers.
 *
 * Used by packages/whatsapp (Meta `X-Hub-Signature-256`) and packages/billing
 * (Razorpay `X-Razorpay-Signature`) -- see ADR-0002 and Master Prompt section 24.
 */

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Computes the lowercase hex-encoded HMAC-SHA256 of `payload` using `secret`. */
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return toHex(signature);
}

/** Constant-time comparison of two equal-length hex strings (falls back to false on length mismatch). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
