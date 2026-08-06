import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  ChatAgentOverloadedError,
  ChatAgentProviderError,
  ChatAgentRateLimitedError,
  ChatAgentRequestFailedError,
  classifyAnthropicError,
} from "../../src/chatAgent/errors.js";

function apiError(
  status: number,
  message = "raw provider message that must never leak",
  errorType?: string,
): Anthropic.APIError {
  return Anthropic.APIError.generate(
    status,
    errorType ? { error: { type: errorType, message } } : { error: { message } },
    message,
    undefined,
  );
}

describe("classifyAnthropicError", () => {
  it("classifies a 429 (rate limited) error as ChatAgentRateLimitedError, carrying the status", () => {
    const classified = classifyAnthropicError(apiError(429, undefined, "rate_limit_error"));
    expect(classified).toBeInstanceOf(ChatAgentRateLimitedError);
    expect(classified.status).toBe(429);
    expect(classified.providerErrorType).toBe("rate_limit_error");
  });

  it("classifies a 529 (overloaded) error as ChatAgentOverloadedError, distinct from 429", () => {
    const classified = classifyAnthropicError(apiError(529));
    expect(classified).toBeInstanceOf(ChatAgentOverloadedError);
    expect(classified).not.toBeInstanceOf(ChatAgentRateLimitedError);
    expect(classified.status).toBe(529);
  });

  it("classifies any other transient 5xx (e.g. 500, 503) as a generic ChatAgentProviderError", () => {
    expect(classifyAnthropicError(apiError(500))).toBeInstanceOf(ChatAgentProviderError);
    expect(classifyAnthropicError(apiError(503))).toBeInstanceOf(ChatAgentProviderError);
  });

  it("classifies a permanent 4xx (e.g. 401, 403, 404) other than 429 as ChatAgentRequestFailedError, carrying the exact status", () => {
    const authError = classifyAnthropicError(apiError(401, undefined, "authentication_error"));
    expect(authError).toBeInstanceOf(ChatAgentRequestFailedError);
    expect(authError.status).toBe(401);
    expect(authError.providerErrorType).toBe("authentication_error");

    const permissionError = classifyAnthropicError(apiError(403, undefined, "permission_error"));
    expect(permissionError.status).toBe(403);

    const notFoundError = classifyAnthropicError(apiError(404, undefined, "not_found_error"));
    expect(notFoundError.status).toBe(404);

    const badRequestError = classifyAnthropicError(
      apiError(400, undefined, "invalid_request_error"),
    );
    expect(badRequestError).toBeInstanceOf(ChatAgentRequestFailedError);
    expect(badRequestError.status).toBe(400);
  });

  it("classifies a non-APIError (e.g. a network error) as a transient ChatAgentProviderError with a null status", () => {
    const networkError = classifyAnthropicError(new Error("ECONNRESET"));
    expect(networkError).toBeInstanceOf(ChatAgentProviderError);
    expect(networkError.status).toBeNull();
    expect(classifyAnthropicError("not even an error object")).toBeInstanceOf(
      ChatAgentProviderError,
    );
  });

  it("never carries the raw provider message onto the classified error", () => {
    const classified = classifyAnthropicError(apiError(529, "super secret internal detail"));
    expect(classified.message).not.toContain("super secret internal detail");
    expect(JSON.stringify(classified)).not.toContain("super secret internal detail");
  });
});
