/**
 * Shared ElevenLabs error handling for both the speech-to-text and
 * text-to-speech adapters (voice pipeline reliability phase). Two distinct
 * concerns live here:
 *
 *  - `ElevenLabsProviderError`: thrown for any non-2xx ElevenLabs response.
 *    Carries only a status code and a coarse safety category -- never the
 *    raw response body, which may contain verbose account/request detail.
 *  - `ElevenLabsConfigurationError`: thrown for a locally-detectable
 *    malformed credential, before any network request is made. Never
 *    carries the key value itself, even partially.
 */

export type ElevenLabsErrorCategory =
  | "rate_limited"
  | "authentication_error"
  | "invalid_request"
  | "server_error"
  | "network_error"
  | "unknown";

/**
 * Thrown for any non-2xx ElevenLabs response, carrying enough detail to
 * classify and log safely without leaking the API key, the Authorization
 * header, or the raw response body (which can include verbose provider-side
 * request/account detail). Mirrors WhatsAppProviderError's shape
 * (packages/whatsapp/src/providers/graphApiProvider.ts) so both providers'
 * errors are sanitized the same way.
 */
export class ElevenLabsProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly category: ElevenLabsErrorCategory,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ElevenLabsProviderError";
  }
}

/**
 * Thrown for a locally-detectable malformed ElevenLabs credential, before
 * any request is attempted. Deliberately generic ("voice_provider_configuration_error")
 * -- never includes the key value, its length, or any fragment of it.
 */
export class ElevenLabsConfigurationError extends Error {
  constructor(reason: string) {
    super(`voice_provider_configuration_error: ${reason}`);
    this.name = "ElevenLabsConfigurationError";
  }
}

/**
 * Classifies an ElevenLabs HTTP status into a safe category and a
 * RETRYABLE/NON_RETRYABLE verdict (voice pipeline reliability phase 5):
 *  - 429 and 5xx are transient -- safe to let the existing Cloudflare Queue
 *    retry mechanism try again.
 *  - 401/403 (bad/revoked credential) and 400/404/415/422 (malformed
 *    request or a deterministically-rejected input) will fail identically
 *    on every retry, so they're classified non-retryable.
 */
export function classifyElevenLabsStatus(status: number): {
  category: ElevenLabsErrorCategory;
  retryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { category: "authentication_error", retryable: false };
  }
  if (status === 429) {
    return { category: "rate_limited", retryable: true };
  }
  if (status >= 500) {
    return { category: "server_error", retryable: true };
  }
  if (status >= 400) {
    return { category: "invalid_request", retryable: false };
  }
  return { category: "unknown", retryable: false };
}

/**
 * Builds a sanitized ElevenLabsProviderError from a failed fetch Response --
 * reads the body only to extract classification, never includes it in the
 * thrown message or forwards it anywhere. Call sites must not read
 * `response.text()`/`.json()` themselves for the error path; use this
 * instead so the raw body never has a second chance to leak into a log.
 */
export function elevenLabsErrorFromStatus(
  operation: string,
  status: number,
): ElevenLabsProviderError {
  const { category, retryable } = classifyElevenLabsStatus(status);
  return new ElevenLabsProviderError(
    `ElevenLabs ${operation} request failed with status ${status} (category: ${category})`,
    status,
    category,
    retryable,
  );
}

/**
 * Wraps a non-HTTP failure (network error, timeout, DNS failure -- fetch()
 * rejecting rather than resolving with a non-ok Response) as a retryable
 * ElevenLabsProviderError. These are always transient by nature: there was
 * no response to classify, so there's no basis for treating them as
 * permanent.
 */
export function elevenLabsNetworkError(operation: string, cause: unknown): ElevenLabsProviderError {
  const detail = cause instanceof Error ? cause.name : "unknown";
  return new ElevenLabsProviderError(
    `ElevenLabs ${operation} request failed before receiving a response (${detail})`,
    0,
    "network_error",
    true,
  );
}

const ELEVENLABS_KEY_PREFIX = "sk_";

/**
 * Rejects an obviously malformed ElevenLabs API key before any request is
 * attempted (voice pipeline reliability phase 6). Only checks shape (a
 * non-empty string with the expected `sk_` prefix for this credential
 * type) -- it cannot and does not verify the key is actually valid, which
 * only ElevenLabs itself can confirm. Never logs, echoes, or includes the
 * key (or any fragment/length of it) in the thrown error.
 */
export function validateElevenLabsApiKeyFormat(apiKey: string): void {
  if (!apiKey || !apiKey.startsWith(ELEVENLABS_KEY_PREFIX)) {
    throw new ElevenLabsConfigurationError("malformed ElevenLabs API key format");
  }
}
