import { encryptWhatsAppAccessToken, type WhatsAppTokenEncryptionKey } from "@dravonix/core";
import { WhatsAppProviderError } from "./providers/graphApiProvider.js";
import {
  exchangeEmbeddedSignupCode,
  inspectAccessToken,
  MetaGraphApiError,
  type MetaAppCredentials,
  type MetaGraphManagementClient,
} from "./providers/embeddedSignupProvider.js";

/**
 * Batch 3, Slice C: orchestrates the server-side half of Meta Embedded
 * Signup, composing Slice B's Graph API primitives (embeddedSignupProvider.ts)
 * with the signup-attempt state machine (migration 37) and the token
 * encryption module (@dravonix/core). This is the module Slice A/B's own doc
 * comments explicitly deferred this composition to.
 *
 * Nothing here trusts browser-supplied data as true merely because it
 * arrived: `wabaId`/`phoneNumberId` are independently re-confirmed against
 * the Graph API using the just-exchanged access token
 * (verifyPhoneBelongsToWaba) before anything is persisted, and `companyId`/
 * `initiatedByUserId` must already have been derived from an authenticated
 * dashboard session by the caller -- this module has no session/auth
 * awareness of its own and never should.
 */

export interface CreateSignupAttemptInput {
  companyId: string;
  initiatedByUserId: string;
  nonceHash: string;
  expiresAt: string;
}

export interface ClaimSignupAttemptInput {
  attemptId: string;
  companyId: string;
  nonceHash: string;
}

export interface CompleteSignupAttemptInput {
  attemptId: string;
  companyId: string;
  wabaId: string;
  phoneNumberId: string;
  metaBusinessId: string | null;
  businessName: string | null;
  displayPhoneNumber: string | null;
  encryptedToken: string;
  encryptionKeyVersion: number;
  tokenExpiresAt: string | null;
}

export interface CompleteSignupAttemptResult {
  whatsappAccountId: string;
  whatsappPhoneNumberId: string;
}

/**
 * Persistence boundary for the whatsapp_signup_attempts state machine
 * (migration 37's create_whatsapp_signup_attempt/claim_whatsapp_signup_attempt/
 * complete_whatsapp_signup RPCs, all service_role-only). Kept as an interface,
 * mirroring @dravonix/tenant's MembershipRepository, so this orchestration is
 * unit-testable without a real Supabase connection.
 */
export interface SignupAttemptRepository {
  createAttempt(input: CreateSignupAttemptInput): Promise<{ id: string; expiresAt: string }>;
  claimAttempt(input: ClaimSignupAttemptInput): Promise<void>;
  completeAttempt(input: CompleteSignupAttemptInput): Promise<CompleteSignupAttemptResult>;
}

export type EmbeddedSignupFlowErrorCode =
  | "attempt_not_claimable"
  | "exchange_failed"
  | "token_verification_failed"
  | "graph_verification_failed"
  | "phone_ownership_mismatch"
  | "registration_failed"
  | "subscription_failed"
  | "persistence_failed";

/**
 * Sanitized, non-secret diagnostic detail for any of the Meta-Graph-API-
 * calling failure codes below, captured ONLY from `WhatsAppProviderError`'s
 * (or its `MetaGraphApiError` subclass's, packages/whatsapp/src/providers/
 * embeddedSignupProvider.ts) own already-sanitized fields -- that class is
 * documented to never carry a raw request/response body, so there is
 * nothing here to redact further. Never includes the authorization code,
 * the exchanged access token, the app secret, a PIN, an Authorization
 * header, or any raw Meta response body -- this module never had access to
 * those at the point this is populated (WhatsAppProviderError itself never
 * captures them either). Populated for every EmbeddedSignupFlowError code
 * that originates from a caught Graph API exception (`exchange_failed`,
 * `token_verification_failed`, `graph_verification_failed`,
 * `registration_failed`, `subscription_failed`) via the shared
 * `captureProviderDiagnostics` helper below. `attempt_not_claimable` and
 * `phone_ownership_mismatch` never get diagnostics -- neither originates
 * from a caught provider exception (the former is a repository-layer
 * rejection, the latter an explicit boolean check on a successful
 * response) -- and `registered.success === false` (a 2xx response with no
 * error body) has nothing to capture either.
 */
export interface EmbeddedSignupFlowErrorDiagnostics {
  /** HTTP status of the failed Meta request, or the synthetic 502 WhatsAppProviderError uses for a transport-level (fetch threw) or malformed-response failure. */
  providerStatus?: number;
  /** Meta's own `error.code` from the response body, when Meta returned one. */
  providerErrorCode?: string;
  /** Meta's own `error.error_subcode` from the response body, when Meta returned one. */
  providerErrorSubcode?: string;
  /** The thrown error's class name (e.g. "WhatsAppProviderError") -- a safe classification, same convention as apps/web/lib/serverLogging.ts's safeErrorDetails. */
  providerErrorType: string;
  /** Meta's own `error.type` (e.g. "OAuthException", "GraphMethodException"), when present -- distinct from `providerErrorType` above, which is this project's own wrapper class name, not Meta's. */
  metaErrorType?: string;
  /** Meta's own `error.error_data.details` -- a short, Meta-authored clarification string, when present. This is the field Meta itself documents as the one to read to disambiguate a generic error.code=100. */
  providerErrorDetail?: string;
}

/**
 * Shared diagnostics-capture logic for every catch block below that wraps a
 * Graph API call: returns sanitized diagnostics when (and only when) the
 * caught value is a real `WhatsAppProviderError` (or its `MetaGraphApiError`
 * subclass) -- `undefined` for anything else (a plain thrown `Error`, a
 * already-classified `EmbeddedSignupFlowError` from a nested call, etc.),
 * since there is nothing safe to report in that case.
 */
function captureProviderDiagnostics(
  error: unknown,
): EmbeddedSignupFlowErrorDiagnostics | undefined {
  if (!(error instanceof WhatsAppProviderError)) return undefined;
  return {
    providerStatus: error.status,
    providerErrorCode: error.errorCode,
    providerErrorSubcode: error.errorSubcode,
    providerErrorType: error.name,
    ...(error instanceof MetaGraphApiError
      ? { metaErrorType: error.metaErrorType, providerErrorDetail: error.errorDetail }
      : {}),
  };
}

/**
 * Every failure this module can throw collapses into one of a small,
 * sanitized set of codes -- never a raw Graph/exception message, never a
 * token, never an authorization code (mirrors
 * whatsapp_accounts.credential_error_code's own controlled vocabulary,
 * migration 37). Safe to show a generic message derived from `code` directly
 * to the browser. `diagnostics`, when present, is equally safe to log/audit
 * (never to the browser) -- see EmbeddedSignupFlowErrorDiagnostics.
 */
export class EmbeddedSignupFlowError extends Error {
  constructor(
    message: string,
    readonly code: EmbeddedSignupFlowErrorCode,
    readonly diagnostics?: EmbeddedSignupFlowErrorDiagnostics,
  ) {
    super(message);
    this.name = "EmbeddedSignupFlowError";
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(byteLength: number): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Bounded well under the DB's own hard 15-minute ceiling
// (whatsapp_signup_attempts_expiry_bounded, migration 37) -- a signup that
// takes longer than this to complete should fail closed and be retried, not
// linger near the database's own limit.
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface InitiateEmbeddedSignupResult {
  attemptId: string;
  /** The raw, one-time nonce -- returned to the browser exactly once, never persisted anywhere (only its hash is stored). */
  nonce: string;
  expiresAt: string;
}

/**
 * Creates a new signup attempt row (pending) and returns the raw nonce
 * exactly once. The browser must hold onto {attemptId, nonce} in memory only
 * (never localStorage/sessionStorage) and send both back, alongside the
 * FB.login result, to `completeEmbeddedSignup` below.
 */
export async function initiateEmbeddedSignup(
  repo: SignupAttemptRepository,
  input: { companyId: string; initiatedByUserId: string },
): Promise<InitiateEmbeddedSignupResult> {
  const nonce = randomHex(32);
  const nonceHash = await sha256Hex(nonce);
  const expiresAt = new Date(Date.now() + ATTEMPT_TTL_MS).toISOString();

  const attempt = await repo.createAttempt({
    companyId: input.companyId,
    initiatedByUserId: input.initiatedByUserId,
    nonceHash,
    expiresAt,
  });

  return { attemptId: attempt.id, nonce, expiresAt: attempt.expiresAt };
}

export interface CompleteEmbeddedSignupInput {
  companyId: string;
  attemptId: string;
  nonce: string;
  code: string;
  /** Browser-reported (postMessage) WABA id -- untrusted until verified below. */
  wabaId: string;
  /** Browser-reported (postMessage) phone number id -- untrusted until verified below. */
  phoneNumberId: string;
  /** Browser-reported (postMessage) business id -- plain provenance metadata only, never a security check (see migration 37's meta_business_id column comment). */
  businessId: string | null;
}

export interface CompleteEmbeddedSignupDeps {
  repo: SignupAttemptRepository;
  metaCredentials: MetaAppCredentials;
  encryptionKey: WhatsAppTokenEncryptionKey;
  /** Constructs a Graph management client authenticated with the just-exchanged access token. */
  graphManagementClientFactory: (accessToken: string) => MetaGraphManagementClient;
}

/**
 * Orchestrates the server-side half of Meta Embedded Signup, after the
 * browser has already completed the FB.login popup and received a code plus
 * the WA_EMBEDDED_SIGNUP postMessage payload. Steps, in order, each of which
 * must succeed before the next runs:
 *
 * 1. Claim the signup attempt (nonce + company match, single-use).
 * 2. Exchange the code for an access token (Slice B, verified contract).
 * 3. Inspect the token and confirm it was issued to THIS app.
 * 4. Confirm the WABA is reachable with this token.
 * 5. Confirm phoneNumberId actually belongs to wabaId (Graph API, never the
 *    browser-reported pairing alone) -- this is what stops a forged
 *    (wabaId, phoneNumberId) pair from ever being trusted.
 * 6. Register the phone number.
 * 7. Subscribe this app to the WABA's webhooks.
 * 8. Encrypt the token and persist, atomically, via complete_whatsapp_signup.
 *
 * If ANY of steps 2-7 fails, this function throws before step 8 ever runs --
 * no whatsapp_accounts/whatsapp_phone_numbers row is written, so a partial
 * failure (e.g. webhook subscription rejected) can never be mistaken for an
 * active connection. The signup_attempt row itself is left in 'processing'
 * in that case; it can never be completed on a retry (a fresh attempt must
 * be initiated instead), and it carries no secret, so this is a harmless,
 * already-documented gap (see migration 37's stale-processing sweep note),
 * not a security issue.
 */
export async function completeEmbeddedSignup(
  deps: CompleteEmbeddedSignupDeps,
  input: CompleteEmbeddedSignupInput,
): Promise<CompleteSignupAttemptResult> {
  const wabaId = input.wabaId.trim();
  const phoneNumberId = input.phoneNumberId.trim();
  if (!wabaId || !phoneNumberId) {
    throw new EmbeddedSignupFlowError(
      "Meta did not report a usable WABA or phone number id",
      "graph_verification_failed",
    );
  }

  const nonceHash = await sha256Hex(input.nonce);
  try {
    await deps.repo.claimAttempt({
      attemptId: input.attemptId,
      companyId: input.companyId,
      nonceHash,
    });
  } catch {
    throw new EmbeddedSignupFlowError(
      "Signup attempt could not be claimed",
      "attempt_not_claimable",
    );
  }

  let accessToken: string;
  let expiresInSeconds: number | null;
  try {
    const exchanged = await exchangeEmbeddedSignupCode({
      ...deps.metaCredentials,
      code: input.code,
    });
    accessToken = exchanged.accessToken;
    expiresInSeconds = exchanged.expiresInSeconds;
  } catch (error) {
    // Diagnostics captured via the shared helper above -- see
    // EmbeddedSignupFlowErrorDiagnostics's own doc comment for exactly what
    // it can and cannot contain. This does not change what's thrown to the
    // caller (still the same generic "exchange_failed" code) -- only what a
    // caller MAY choose to log/audit alongside it.
    throw new EmbeddedSignupFlowError(
      "Meta code exchange failed",
      "exchange_failed",
      captureProviderDiagnostics(error),
    );
  }

  let debugTokenExpiresAt: number | null;
  try {
    const inspection = await inspectAccessToken(deps.metaCredentials, accessToken);
    if (!inspection.isValid || inspection.appId !== deps.metaCredentials.appId) {
      throw new EmbeddedSignupFlowError(
        "Exchanged access token failed verification",
        "token_verification_failed",
      );
    }
    debugTokenExpiresAt = inspection.expiresAt;
  } catch (error) {
    if (error instanceof EmbeddedSignupFlowError) throw error;
    throw new EmbeddedSignupFlowError(
      "Access token inspection failed",
      "token_verification_failed",
      captureProviderDiagnostics(error),
    );
  }

  const graphClient = deps.graphManagementClientFactory(accessToken);

  let businessName: string | null;
  try {
    const account = await graphClient.getWhatsAppBusinessAccount(wabaId);
    businessName = account.name;
  } catch (error) {
    throw new EmbeddedSignupFlowError(
      "WABA is not accessible with the exchanged token",
      "graph_verification_failed",
      captureProviderDiagnostics(error),
    );
  }

  let displayPhoneNumber: string | null;
  try {
    const belongs = await graphClient.verifyPhoneBelongsToWaba(wabaId, phoneNumberId);
    if (!belongs) {
      throw new EmbeddedSignupFlowError(
        "Reported phone number does not belong to the reported WABA",
        "phone_ownership_mismatch",
      );
    }
    const phoneNumbers = await graphClient.getPhoneNumbersForWaba(wabaId);
    displayPhoneNumber =
      phoneNumbers.find((phone) => phone.id === phoneNumberId)?.displayPhoneNumber ?? null;
  } catch (error) {
    if (error instanceof EmbeddedSignupFlowError) throw error;
    throw new EmbeddedSignupFlowError(
      "Phone ownership verification failed",
      "graph_verification_failed",
      captureProviderDiagnostics(error),
    );
  }

  try {
    const registered = await graphClient.registerPhoneNumber(phoneNumberId);
    if (!registered.success) {
      throw new EmbeddedSignupFlowError(
        "Phone number registration was rejected",
        "registration_failed",
      );
    }
  } catch (error) {
    if (error instanceof EmbeddedSignupFlowError) throw error;
    // Diagnostics captured via the shared helper above -- same mechanism and
    // same guarantees as every other Graph-call catch block in this
    // function: never the access token, PIN, Authorization header, or a raw
    // Graph response body. Does not change what's thrown to the caller
    // (still the same generic "registration_failed" code) -- only what a
    // caller MAY choose to log/audit alongside it.
    throw new EmbeddedSignupFlowError(
      "Phone number registration failed",
      "registration_failed",
      captureProviderDiagnostics(error),
    );
  }

  try {
    const subscribed = await graphClient.subscribeAppToWaba(wabaId);
    if (!subscribed.success) {
      throw new EmbeddedSignupFlowError("Webhook subscription was rejected", "subscription_failed");
    }
  } catch (error) {
    if (error instanceof EmbeddedSignupFlowError) throw error;
    throw new EmbeddedSignupFlowError(
      "Webhook subscription failed",
      "subscription_failed",
      captureProviderDiagnostics(error),
    );
  }

  // AAD-bound to the WABA id, not the (not-yet-known-at-encryption-time, for
  // a first-time connection) whatsapp_accounts row id: waba_id is Meta's own
  // stable identity for this credential and is known before
  // complete_whatsapp_signup has decided whether to insert or update a row.
  // Any future decryption call site (Slice E outbound-send credential
  // resolution) MUST pass this same waba_id, never whatsapp_accounts.id.
  const encryptedToken = await encryptWhatsAppAccessToken(accessToken, wabaId, deps.encryptionKey);

  const tokenExpiresAt =
    debugTokenExpiresAt !== null && debugTokenExpiresAt > 0
      ? new Date(debugTokenExpiresAt * 1000).toISOString()
      : expiresInSeconds !== null
        ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
        : null;

  try {
    return await deps.repo.completeAttempt({
      attemptId: input.attemptId,
      companyId: input.companyId,
      wabaId,
      phoneNumberId,
      metaBusinessId: input.businessId,
      businessName,
      displayPhoneNumber,
      encryptedToken,
      encryptionKeyVersion: deps.encryptionKey.version,
      tokenExpiresAt,
    });
  } catch {
    throw new EmbeddedSignupFlowError(
      "Failed to persist the WhatsApp connection",
      "persistence_failed",
    );
  }
}
