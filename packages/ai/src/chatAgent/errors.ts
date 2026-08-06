import Anthropic from "@anthropic-ai/sdk";

/** A required field for the requested action was missing (e.g. no draft text for rewrite_draft). Safe to show verbatim to staff. */
export class ChatAgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatAgentValidationError";
  }
}

/**
 * Sanitized, log-safe metadata carried on every classified provider error --
 * `status` is a plain HTTP status number and `providerErrorType` is
 * Anthropic's own short categorical error label (e.g.
 * "authentication_error", "not_found_error"). Deliberately excludes the raw
 * error message/body: that field can echo request content and must never be
 * logged or forwarded to the browser.
 */
export interface ChatAgentProviderErrorInfo {
  status: number | null;
  providerErrorType: string | null;
}

function extractProviderErrorInfo(error: unknown): ChatAgentProviderErrorInfo {
  if (error instanceof Anthropic.APIError) {
    // Anthropic's error envelope is { type: "error", error: { type, message } }
    // -- the SDK stores that whole parsed body (not just the inner object) as
    // `APIError.error`, so the categorical type is nested one level deeper,
    // at `error.error.error.type`.
    const body = error.error as { error?: { type?: unknown } } | undefined;
    return {
      status: typeof error.status === "number" ? error.status : null,
      providerErrorType: typeof body?.error?.type === "string" ? body.error.type : null,
    };
  }
  return { status: null, providerErrorType: null };
}

/** Anthropic returned HTTP 429 (rate limited). The caller shows a "too many requests" message -- no retry/backoff is implemented here (reserved for claude/anthropic-overload-retry). */
export class ChatAgentRateLimitedError extends Error {
  readonly status: number | null;
  readonly providerErrorType: string | null;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_provider_rate_limited");
    this.name = "ChatAgentRateLimitedError";
    this.status = info.status;
    this.providerErrorType = info.providerErrorType;
  }
}

/** Anthropic returned HTTP 529 (overloaded). The caller shows a "temporarily busy" message -- no retry/backoff is implemented here (reserved for claude/anthropic-overload-retry). */
export class ChatAgentOverloadedError extends Error {
  readonly status: number | null;
  readonly providerErrorType: string | null;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_provider_overloaded");
    this.name = "ChatAgentOverloadedError";
    this.status = info.status;
    this.providerErrorType = info.providerErrorType;
  }
}

/** A network failure or a transient (non-529) 5xx from Anthropic. The caller shows a "temporarily unavailable" message. Never carries the raw provider message -- see classifyAnthropicError. */
export class ChatAgentProviderError extends Error {
  readonly status: number | null;
  readonly providerErrorType: string | null;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_provider_error");
    this.name = "ChatAgentProviderError";
    this.status = info.status;
    this.providerErrorType = info.providerErrorType;
  }
}

/**
 * A permanent, non-retryable Anthropic request/config error -- 400 (invalid
 * request/model), 401 (invalid API key), 403 (model/account access denied),
 * 404 (model not found), or any other 4xx other than 429. The caller
 * branches on `.status` to choose between a generic "could not complete
 * this request" message (400 and anything unrecognized) and a specific
 * "contact your administrator" message for 401/403/404, which are always
 * configuration problems rather than something the requesting user caused.
 */
export class ChatAgentRequestFailedError extends Error {
  readonly status: number | null;
  readonly providerErrorType: string | null;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_request_failed");
    this.name = "ChatAgentRequestFailedError";
    this.status = info.status;
    this.providerErrorType = info.providerErrorType;
  }
}

/** The model's response could not be parsed/validated for a structured action (summarize/extract_lead). The provider call itself succeeded (HTTP 200) -- this is a response-shape failure, not a request failure. Treated the same as a permanent request failure for the caller's safe message. */
export class ChatAgentResponseError extends Error {
  constructor() {
    super("chat_agent_response_invalid");
    this.name = "ChatAgentResponseError";
  }
}

/**
 * Maps a raw Anthropic SDK error to one of this module's own error types --
 * the raw `error.message`/stack/request id is deliberately never read here,
 * so it can never leak into a message a Server Action might forward. Each
 * classified error carries only a plain HTTP status and Anthropic's own
 * short categorical error type, safe to log.
 *
 *  - 429 (rate limited)        -> ChatAgentRateLimitedError
 *  - 529 (overloaded)          -> ChatAgentOverloadedError
 *  - any other 5xx APIError    -> ChatAgentProviderError (transient)
 *  - any other APIError        -> ChatAgentRequestFailedError (permanent --
 *    the caller further branches on .status for 400/401/403/404)
 *  - a non-APIError failure (e.g. a network error/timeout) is treated as
 *    transient -> ChatAgentProviderError
 */
export function classifyAnthropicError(
  error: unknown,
):
  | ChatAgentRateLimitedError
  | ChatAgentOverloadedError
  | ChatAgentProviderError
  | ChatAgentRequestFailedError {
  const info = extractProviderErrorInfo(error);
  if (error instanceof Anthropic.APIError) {
    if (error.status === 429) return new ChatAgentRateLimitedError(info);
    if (error.status === 529) return new ChatAgentOverloadedError(info);
    if (typeof error.status === "number" && error.status >= 500) {
      return new ChatAgentProviderError(info);
    }
    return new ChatAgentRequestFailedError(info);
  }
  return new ChatAgentProviderError(info);
}
