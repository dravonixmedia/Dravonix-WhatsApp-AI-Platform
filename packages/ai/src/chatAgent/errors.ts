import Anthropic from "@anthropic-ai/sdk";

/**
 * Mirrors the pinned dependency version (packages/ai/package.json's
 * "@anthropic-ai/sdk": "^0.55.0", resolved to exactly 0.55.0 in the
 * lockfile -- bumped from 0.32.1 to add native Web Search tool type support,
 * see research/anthropicWebSearch.ts). The installed SDK doesn't re-export
 * its own VERSION constant from the main entrypoint, so this is a plain
 * literal -- safe to log, update it if the pin changes.
 */
export const ANTHROPIC_SDK_VERSION = "0.55.0";

/**
 * Stable, serializable discriminant carried on every classified Chat Agent
 * error, in addition to its class/instanceof identity. Cloudflare/OpenNext
 * bundling can in principle produce two separate module instances of this
 * package (so a thrown error and the `instanceof` check at the catch site
 * come from different copies of the same class) -- the `category` string
 * survives that boundary since it's a plain data property, not identity.
 * Every `isChatAgentXError` guard below checks `instanceof` first (the
 * common, correct case) and falls back to this property, so classification
 * is never *solely* dependent on `instanceof`.
 */
export type ChatAgentErrorCategory =
  | "validation"
  | "connection_failed"
  | "connection_timeout"
  | "rate_limited"
  | "overloaded"
  | "provider_error"
  | "request_failed"
  | "response_error";

function hasCategory(error: unknown, category: ChatAgentErrorCategory): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    (error as { category?: unknown }).category === category
  );
}

/**
 * Reads a value's constructor name via plain property access, not
 * `instanceof` -- used as the structural fallback for recognizing SDK
 * error types (Anthropic.APIConnectionError etc.) in case Cloudflare/
 * OpenNext bundling ever produces two separate module instances of the
 * Anthropic SDK itself (the same class-identity risk as this package's own
 * errors, one level down the dependency graph).
 */
function constructorName(value: unknown): string | null {
  if (value !== null && typeof value === "object" && value.constructor) {
    return value.constructor.name || null;
  }
  return null;
}

/** A required field for the requested action was missing (e.g. no draft text for rewrite_draft). Safe to show verbatim to staff. */
export class ChatAgentValidationError extends Error {
  readonly category = "validation" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChatAgentValidationError";
  }
}

export function isChatAgentValidationError(error: unknown): error is ChatAgentValidationError {
  return error instanceof ChatAgentValidationError || hasCategory(error, "validation");
}

/**
 * Sanitized, log-safe metadata carried on every classified provider error.
 * `status` is a plain HTTP status number (null when no HTTP response was
 * ever received -- a connection/timeout failure) and `providerErrorType` is
 * Anthropic's own short categorical error label (e.g.
 * "authentication_error", "not_found_error"). `errorConstructorName` and
 * `causeConstructorName` are plain class-name strings (e.g.
 * "APIConnectionError", "FetchError") -- never the error's own message,
 * which can include a hostname, stack fragment, or other detail. Never
 * includes the raw error message/body, request headers, or response
 * content.
 */
export interface ChatAgentProviderErrorInfo {
  status: number | null;
  providerErrorType: string | null;
  errorConstructorName: string | null;
  causeConstructorName: string | null;
  sdkVersion: string;
}

function extractProviderErrorInfo(error: unknown): ChatAgentProviderErrorInfo {
  const causeConstructorName =
    error instanceof Object && "cause" in error
      ? constructorName((error as { cause?: unknown }).cause)
      : null;
  if (error instanceof Anthropic.APIError) {
    // Anthropic's error envelope is { type: "error", error: { type, message } }
    // -- the SDK stores that whole parsed body (not just the inner object) as
    // `APIError.error`, so the categorical type is nested one level deeper,
    // at `error.error.error.type`.
    const body = error.error as { error?: { type?: unknown } } | undefined;
    return {
      status: typeof error.status === "number" ? error.status : null,
      providerErrorType: typeof body?.error?.type === "string" ? body.error.type : null,
      errorConstructorName: constructorName(error),
      causeConstructorName,
      sdkVersion: ANTHROPIC_SDK_VERSION,
    };
  }
  return {
    status: null,
    providerErrorType: null,
    errorConstructorName: constructorName(error),
    causeConstructorName,
    sdkVersion: ANTHROPIC_SDK_VERSION,
  };
}

/**
 * The Anthropic client never reached a response at all -- no HTTP status,
 * no response body, a pure transport/network failure (DNS, TLS, refused
 * connection, or -- the confirmed cause in Cloudflare Workers -- the SDK's
 * auto-detected Node fetch implementation failing outright inside the
 * Workers sandbox, which does not support raw Node socket APIs). Distinct
 * from ChatAgentConnectionTimeoutError (a bounded wait that elapsed,
 * checked first since it's a subtype of the same SDK error family).
 */
export class ChatAgentConnectionError extends Error {
  readonly category = "connection_failed" as const;
  readonly status: null = null;
  readonly providerErrorType: null = null;
  readonly errorConstructorName: string | null;
  readonly causeConstructorName: string | null;
  readonly sdkVersion: string;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_connection_failed");
    this.name = "ChatAgentConnectionError";
    this.errorConstructorName = info.errorConstructorName;
    this.causeConstructorName = info.causeConstructorName;
    this.sdkVersion = info.sdkVersion;
  }
}

export function isChatAgentConnectionError(error: unknown): error is ChatAgentConnectionError {
  return error instanceof ChatAgentConnectionError || hasCategory(error, "connection_failed");
}

/** The request timed out waiting for Anthropic -- a bounded wait elapsed with no response, not a hard connection refusal. */
export class ChatAgentConnectionTimeoutError extends Error {
  readonly category = "connection_timeout" as const;
  readonly status: null = null;
  readonly providerErrorType: null = null;
  readonly errorConstructorName: string | null;
  readonly causeConstructorName: string | null;
  readonly sdkVersion: string;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_connection_timeout");
    this.name = "ChatAgentConnectionTimeoutError";
    this.errorConstructorName = info.errorConstructorName;
    this.causeConstructorName = info.causeConstructorName;
    this.sdkVersion = info.sdkVersion;
  }
}

export function isChatAgentConnectionTimeoutError(
  error: unknown,
): error is ChatAgentConnectionTimeoutError {
  return (
    error instanceof ChatAgentConnectionTimeoutError || hasCategory(error, "connection_timeout")
  );
}

/** Anthropic returned HTTP 429 (rate limited). The caller shows a "too many requests" message -- no retry/backoff is implemented here (reserved for claude/anthropic-overload-retry). */
export class ChatAgentRateLimitedError extends Error {
  readonly category = "rate_limited" as const;
  readonly status: number | null;
  readonly providerErrorType: string | null;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_provider_rate_limited");
    this.name = "ChatAgentRateLimitedError";
    this.status = info.status;
    this.providerErrorType = info.providerErrorType;
  }
}

export function isChatAgentRateLimitedError(error: unknown): error is ChatAgentRateLimitedError {
  return error instanceof ChatAgentRateLimitedError || hasCategory(error, "rate_limited");
}

/** Anthropic returned HTTP 529 (overloaded). The caller shows a "temporarily busy" message -- no retry/backoff is implemented here (reserved for claude/anthropic-overload-retry). */
export class ChatAgentOverloadedError extends Error {
  readonly category = "overloaded" as const;
  readonly status: number | null;
  readonly providerErrorType: string | null;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_provider_overloaded");
    this.name = "ChatAgentOverloadedError";
    this.status = info.status;
    this.providerErrorType = info.providerErrorType;
  }
}

export function isChatAgentOverloadedError(error: unknown): error is ChatAgentOverloadedError {
  return error instanceof ChatAgentOverloadedError || hasCategory(error, "overloaded");
}

/** A transient (non-529) 5xx from Anthropic -- a real HTTP response was received, just a server-side failure. The caller shows a "temporarily unavailable" message. Never carries the raw provider message -- see classifyAnthropicError. */
export class ChatAgentProviderError extends Error {
  readonly category = "provider_error" as const;
  readonly status: number | null;
  readonly providerErrorType: string | null;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_provider_error");
    this.name = "ChatAgentProviderError";
    this.status = info.status;
    this.providerErrorType = info.providerErrorType;
  }
}

export function isChatAgentProviderError(error: unknown): error is ChatAgentProviderError {
  return error instanceof ChatAgentProviderError || hasCategory(error, "provider_error");
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
  readonly category = "request_failed" as const;
  readonly status: number | null;
  readonly providerErrorType: string | null;
  constructor(info: ChatAgentProviderErrorInfo) {
    super("chat_agent_request_failed");
    this.name = "ChatAgentRequestFailedError";
    this.status = info.status;
    this.providerErrorType = info.providerErrorType;
  }
}

export function isChatAgentRequestFailedError(
  error: unknown,
): error is ChatAgentRequestFailedError {
  return error instanceof ChatAgentRequestFailedError || hasCategory(error, "request_failed");
}

/** Which stage of structured-response handling failed -- see packages/ai/src/chatAgent/actions.ts's parseActionResponse. */
export type ChatAgentResponseFailureStage =
  | "empty_response"
  | "json_extraction"
  | "json_parse"
  | "schema_validation"
  | "result_serialization";

/**
 * The model's response could not be turned into the action's required
 * output. The provider call itself succeeded (HTTP 200) -- this is a
 * response-shape failure, not a request failure. `stage` pinpoints exactly
 * where it happened (never which text caused it); `responseCharacterCount`
 * and `validationIssueCount` are plain counts, safe to log -- never the
 * response text or the parsed field values themselves.
 */
export class ChatAgentResponseError extends Error {
  readonly category = "response_error" as const;
  readonly stage: ChatAgentResponseFailureStage;
  readonly responseCharacterCount: number | null;
  readonly validationIssueCount: number | null;
  constructor(
    stage: ChatAgentResponseFailureStage,
    options: { responseCharacterCount?: number; validationIssueCount?: number } = {},
  ) {
    super("chat_agent_response_invalid");
    this.name = "ChatAgentResponseError";
    this.stage = stage;
    this.responseCharacterCount = options.responseCharacterCount ?? null;
    this.validationIssueCount = options.validationIssueCount ?? null;
  }
}

export function isChatAgentResponseError(error: unknown): error is ChatAgentResponseError {
  return error instanceof ChatAgentResponseError || hasCategory(error, "response_error");
}

/**
 * Maps a raw Anthropic SDK error to one of this module's own error types --
 * the raw `error.message`/stack/request id is deliberately never read here,
 * so it can never leak into a message a Server Action might forward. Each
 * classified error carries only a plain HTTP status, Anthropic's own short
 * categorical error type, and plain constructor-name strings, safe to log.
 *
 * Connection/timeout errors are checked FIRST and via a structural
 * constructor-name fallback, not bare `instanceof Anthropic.X`: both
 * `APIConnectionError` and `APIConnectionTimeoutError` are themselves
 * subclasses of `Anthropic.APIError` with `status: undefined`, so without
 * this explicit check they would silently fall through to
 * ChatAgentRequestFailedError (a "permanent request/config error") even
 * though no HTTP response was ever received -- exactly the ambiguity
 * observed in production (httpStatus: null, providerErrorType: null,
 * internalCategory: AI_REQUEST_FAILED for what was actually a transport
 * failure).
 *
 *  - connection timeout          -> ChatAgentConnectionTimeoutError
 *  - connection/transport failure -> ChatAgentConnectionError
 *  - 429 (rate limited)          -> ChatAgentRateLimitedError
 *  - 529 (overloaded)            -> ChatAgentOverloadedError
 *  - any other 5xx APIError      -> ChatAgentProviderError (transient)
 *  - any other APIError          -> ChatAgentRequestFailedError (permanent
 *    -- the caller further branches on .status for 400/401/403/404)
 *  - a non-APIError, non-SDK failure is treated as transient
 *    -> ChatAgentProviderError
 */
export function classifyAnthropicError(
  error: unknown,
):
  | ChatAgentConnectionError
  | ChatAgentConnectionTimeoutError
  | ChatAgentRateLimitedError
  | ChatAgentOverloadedError
  | ChatAgentProviderError
  | ChatAgentRequestFailedError {
  const info = extractProviderErrorInfo(error);
  const ctorName = constructorName(error);

  const isTimeout =
    error instanceof Anthropic.APIConnectionTimeoutError ||
    ctorName === "APIConnectionTimeoutError";
  if (isTimeout) return new ChatAgentConnectionTimeoutError(info);

  const isConnectionFailure =
    error instanceof Anthropic.APIConnectionError || ctorName === "APIConnectionError";
  if (isConnectionFailure) return new ChatAgentConnectionError(info);

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
