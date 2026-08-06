import Anthropic from "@anthropic-ai/sdk";

/** A required field for the requested action was missing (e.g. no draft text for rewrite_draft). Safe to show verbatim to staff. */
export class ChatAgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatAgentValidationError";
  }
}

/** Anthropic returned an overloaded/rate-limited response (HTTP 429 or 529). The caller shows a "try again shortly" message -- no retry/backoff is implemented here (reserved for claude/anthropic-overload-retry). */
export class ChatAgentOverloadedError extends Error {
  constructor() {
    super("chat_agent_provider_overloaded");
    this.name = "ChatAgentOverloadedError";
  }
}

/** Any other provider failure (network, auth misconfiguration, invalid response). Never carries the raw provider message -- see classifyAnthropicError. */
export class ChatAgentProviderError extends Error {
  constructor() {
    super("chat_agent_provider_error");
    this.name = "ChatAgentProviderError";
  }
}

/** The model's response could not be parsed/validated for a structured action (summarize/extract_lead). */
export class ChatAgentResponseError extends Error {
  constructor() {
    super("chat_agent_response_invalid");
    this.name = "ChatAgentResponseError";
  }
}

/**
 * Maps a raw Anthropic SDK error to one of this module's own error types --
 * the raw `error.message`/stack/request id is deliberately never read here,
 * so it can never leak into a thrown message a Server Action might forward.
 * 429 (rate limited) and 529 (overloaded) both surface as the same
 * "temporarily busy" category; every other APIError (or non-APIError
 * failure, e.g. a network error) is a generic provider error.
 */
export function classifyAnthropicError(
  error: unknown,
): ChatAgentOverloadedError | ChatAgentProviderError {
  if (error instanceof Anthropic.APIError && (error.status === 529 || error.status === 429)) {
    return new ChatAgentOverloadedError();
  }
  return new ChatAgentProviderError();
}
