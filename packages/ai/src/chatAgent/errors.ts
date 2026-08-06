import Anthropic from "@anthropic-ai/sdk";

/** A required field for the requested action was missing (e.g. no draft text for rewrite_draft). Safe to show verbatim to staff. */
export class ChatAgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatAgentValidationError";
  }
}

/** Anthropic returned HTTP 429 (rate limited). The caller shows a "too many requests" message -- no retry/backoff is implemented here (reserved for claude/anthropic-overload-retry). */
export class ChatAgentRateLimitedError extends Error {
  constructor() {
    super("chat_agent_provider_rate_limited");
    this.name = "ChatAgentRateLimitedError";
  }
}

/** Anthropic returned HTTP 529 (overloaded). The caller shows a "temporarily busy" message -- no retry/backoff is implemented here (reserved for claude/anthropic-overload-retry). */
export class ChatAgentOverloadedError extends Error {
  constructor() {
    super("chat_agent_provider_overloaded");
    this.name = "ChatAgentOverloadedError";
  }
}

/** A network failure or a transient (non-529) 5xx from Anthropic. The caller shows a "temporarily unavailable" message. Never carries the raw provider message -- see classifyAnthropicError. */
export class ChatAgentProviderError extends Error {
  constructor() {
    super("chat_agent_provider_error");
    this.name = "ChatAgentProviderError";
  }
}

/** A permanent, non-retryable Anthropic request/config error (e.g. 400/401/403/404 -- anything other than 429/529/5xx). The caller shows a fixed "could not complete this request" message. */
export class ChatAgentRequestFailedError extends Error {
  constructor() {
    super("chat_agent_request_failed");
    this.name = "ChatAgentRequestFailedError";
  }
}

/** The model's response could not be parsed/validated for a structured action (summarize/extract_lead). Treated the same as a permanent request failure. */
export class ChatAgentResponseError extends Error {
  constructor() {
    super("chat_agent_response_invalid");
    this.name = "ChatAgentResponseError";
  }
}

/**
 * Maps a raw Anthropic SDK error to one of this module's own error types --
 * the raw `error.message`/stack/request id is deliberately never read here,
 * so it can never leak into a message a Server Action might forward.
 *
 *  - 429 (rate limited)        -> ChatAgentRateLimitedError
 *  - 529 (overloaded)          -> ChatAgentOverloadedError
 *  - any other 5xx APIError    -> ChatAgentProviderError (transient)
 *  - any other APIError        -> ChatAgentRequestFailedError (permanent)
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
  if (error instanceof Anthropic.APIError) {
    if (error.status === 429) return new ChatAgentRateLimitedError();
    if (error.status === 529) return new ChatAgentOverloadedError();
    if (typeof error.status === "number" && error.status >= 500) {
      return new ChatAgentProviderError();
    }
    return new ChatAgentRequestFailedError();
  }
  return new ChatAgentProviderError();
}
