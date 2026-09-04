import { AppError } from "./errors.js";

/**
 * Encrypts/decrypts WhatsApp Embedded Signup access tokens at rest, using
 * AES-256-GCM via the Web Crypto API (available as `globalThis.crypto.subtle`
 * in both Node.js 20+ and the Cloudflare Workers runtime -- the same
 * portability reasoning as this package's own hmacSha256Hex in crypto.ts).
 *
 * Envelope (stored verbatim in whatsapp_accounts.encrypted_access_token):
 *   { "v": 1, "kv": <key version>, "iv": "<base64url, 12 bytes>", "ct": "<base64url>" }
 * `ct` is exactly Web Crypto's own AES-GCM output (ciphertext with the
 * 128-bit authentication tag appended) -- never split or recombined
 * manually, so there is no custom cryptographic serialization to get wrong.
 *
 * Every encrypt/decrypt call is bound (via AAD) to a fixed purpose string
 * and the specific whatsapp_accounts row it belongs to, so a ciphertext
 * copied to a different row, or reused for a different purpose, fails to
 * decrypt outright rather than silently succeeding in the wrong context.
 *
 * Decryption failures are never distinguished from one another in the
 * thrown error (malformed envelope, wrong key, wrong AAD, tampered
 * ciphertext, and unknown key version all produce the same generic
 * CredentialDecryptionError) -- this is deliberate: distinguishing them
 * would give an oracle to a caller probing stored credential material.
 */

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12; // 96-bit GCM IV
const KEY_BYTES = 32; // 256-bit AES key

/** Thrown for a caller-side misuse of the encryption API (not a security-sensitive failure -- the caller controls these inputs). */
export class CredentialEncryptionError extends AppError {
  constructor(message: string) {
    super("credential_encryption_error", message);
  }
}

/**
 * Thrown for any decryption failure. Deliberately generic -- never states
 * whether the envelope was malformed, the key was wrong, the AAD didn't
 * match, the ciphertext was tampered with, or the key version is unknown.
 * Never includes the ciphertext, the envelope, or any key material.
 */
export class CredentialDecryptionError extends AppError {
  constructor() {
    super("credential_decryption_error", "Failed to decrypt stored credential");
  }
}

export interface WhatsAppTokenEncryptionKey {
  /** The key version this key material corresponds to (stored alongside the ciphertext, never inferred). */
  readonly version: number;
  /** Raw 256-bit key, base64-encoded (standard base64, not base64url -- this is env-var material, not envelope content). */
  readonly keyBase64: string;
}

interface TokenEnvelope {
  v: number;
  kv: number;
  iv: string;
  ct: string;
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws (via the caller's try/catch) on invalid base64url input -- never assume well-formed input from an envelope that came from storage. */
function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return base64ToBytes(padded);
}

function additionalDataFor(whatsappAccountId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`purpose=whatsapp_access_token;account=${whatsappAccountId}`);
}

async function importAesGcmKey(
  keyBase64: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = base64ToBytes(keyBase64);
  } catch {
    throw new CredentialEncryptionError("Encryption key is not valid base64");
  }
  if (keyBytes.length !== KEY_BYTES) {
    throw new CredentialEncryptionError(
      `Encryption key must be exactly ${KEY_BYTES} bytes (256 bits) once base64-decoded, got ${keyBytes.length}`,
    );
  }
  return globalThis.crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [usage]);
}

/**
 * Encrypts a plaintext WhatsApp access token for storage in
 * whatsapp_accounts.encrypted_access_token. `whatsappAccountId` must be the
 * exact row the ciphertext will be stored against -- it is baked into the
 * AAD, so the resulting envelope can only ever be decrypted for that same
 * account id.
 */
export async function encryptWhatsAppAccessToken(
  plaintextToken: string,
  whatsappAccountId: string,
  key: WhatsAppTokenEncryptionKey,
): Promise<string> {
  if (plaintextToken.length === 0) {
    throw new CredentialEncryptionError("Cannot encrypt an empty token");
  }
  if (whatsappAccountId.length === 0) {
    throw new CredentialEncryptionError("whatsappAccountId is required to bind the encryption AAD");
  }
  if (!Number.isInteger(key.version) || key.version < 1) {
    throw new CredentialEncryptionError("Key version must be a positive integer");
  }

  const cryptoKey = await importAesGcmKey(key.keyBase64, "encrypt");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintextBytes = new TextEncoder().encode(plaintextToken);

  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalDataFor(whatsappAccountId) },
    cryptoKey,
    plaintextBytes,
  );

  const envelope: TokenEnvelope = {
    v: ENVELOPE_VERSION,
    kv: key.version,
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

/** Structural validation only -- never throws detail about which field is wrong; a malformed envelope collapses into the same CredentialDecryptionError as every other decryption failure. */
function parseEnvelope(envelopeJson: string): TokenEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeJson);
  } catch {
    throw new CredentialDecryptionError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new CredentialDecryptionError();
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.v !== "number" ||
    typeof candidate.kv !== "number" ||
    typeof candidate.iv !== "string" ||
    typeof candidate.ct !== "string" ||
    candidate.iv.length === 0 ||
    candidate.ct.length === 0
  ) {
    throw new CredentialDecryptionError();
  }
  if (candidate.v !== ENVELOPE_VERSION) throw new CredentialDecryptionError();
  return candidate as unknown as TokenEnvelope;
}

/**
 * Decrypts an envelope previously produced by encryptWhatsAppAccessToken.
 * `resolveKey` looks up the key material for the envelope's own recorded
 * key version (`kv`) -- returning `undefined` for an unrecognized version is
 * treated identically to every other decryption failure. `whatsappAccountId`
 * must match the value the envelope was originally encrypted with; a
 * mismatch fails the AAD check inside Web Crypto itself.
 */
export async function decryptWhatsAppAccessToken(
  envelopeJson: string,
  whatsappAccountId: string,
  resolveKey: (keyVersion: number) => string | undefined,
): Promise<string> {
  const envelope = parseEnvelope(envelopeJson);

  const keyBase64 = resolveKey(envelope.kv);
  if (keyBase64 === undefined) throw new CredentialDecryptionError();

  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    iv = base64UrlToBytes(envelope.iv);
    ciphertext = base64UrlToBytes(envelope.ct);
  } catch {
    throw new CredentialDecryptionError();
  }
  if (iv.length !== IV_BYTES) throw new CredentialDecryptionError();

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await importAesGcmKey(keyBase64, "decrypt");
  } catch {
    throw new CredentialDecryptionError();
  }

  try {
    const plaintextBytes = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: additionalDataFor(whatsappAccountId) },
      cryptoKey,
      ciphertext,
    );
    return new TextDecoder().decode(plaintextBytes);
  } catch {
    // Wrong key, wrong AAD (including a mismatched whatsappAccountId), and a
    // tampered ciphertext/tag all surface here as Web Crypto's own
    // OperationError -- deliberately collapsed into the same generic error.
    throw new CredentialDecryptionError();
  }
}
