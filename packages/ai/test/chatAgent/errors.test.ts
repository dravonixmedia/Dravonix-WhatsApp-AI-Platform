import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_SDK_VERSION,
  ChatAgentConnectionError,
  ChatAgentConnectionTimeoutError,
  ChatAgentOverloadedError,
  ChatAgentProviderError,
  ChatAgentRateLimitedError,
  ChatAgentRequestFailedError,
  ChatAgentResponseError,
  ChatAgentValidationError,
  classifyAnthropicError,
  isChatAgentConnectionError,
  isChatAgentConnectionTimeoutError,
  isChatAgentOverloadedError,
  isChatAgentProviderError,
  isChatAgentRateLimitedError,
  isChatAgentRequestFailedError,
  isChatAgentResponseError,
  isChatAgentValidationError,
} from "../../src/chatAgent/errors.js";

function apiError(
  status: number,
  message = "raw provider message that must never leak",
  errorType?: string,
): Anthropic.APIError {
  // SDK 0.55+'s APIError.generate() treats a falsy `headers` argument as "no
  // HTTP response was ever received" and always produces an
  // APIConnectionError regardless of `status` -- a real (even if empty)
  // Headers instance is required to fabricate a genuine HTTP-status error
  // for this test double (see APIError.generate in
  // @anthropic-ai/sdk/core/error.js: `if (!status || !headers) return new
  // APIConnectionError(...)`).
  return Anthropic.APIError.generate(
    status,
    errorType ? { error: { type: errorType, message } } : { error: { message } },
    message,
    new Headers(),
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

describe("classifyAnthropicError: connection/timeout failures (no HTTP response ever received)", () => {
  it("classifies Anthropic.APIConnectionTimeoutError as ChatAgentConnectionTimeoutError, not a generic request failure", () => {
    const timeoutError = new Anthropic.APIConnectionTimeoutError();
    const classified = classifyAnthropicError(timeoutError);
    expect(classified).toBeInstanceOf(ChatAgentConnectionTimeoutError);
    expect(classified).not.toBeInstanceOf(ChatAgentRequestFailedError);
    expect(classified.status).toBeNull();
  });

  it("classifies Anthropic.APIConnectionError as ChatAgentConnectionError, not a generic request failure", () => {
    const connectionError = new Anthropic.APIConnectionError({
      message: "Connection error.",
      cause: new TypeError("fetch failed"),
    });
    const classified = classifyAnthropicError(connectionError);
    expect(classified).toBeInstanceOf(ChatAgentConnectionError);
    expect(classified).not.toBeInstanceOf(ChatAgentRequestFailedError);
    expect(classified.status).toBeNull();
  });

  it("distinguishes a connection failure from a genuine permanent 4xx -- both have status null vs. a real number, never confused", () => {
    // This is the exact ambiguity observed in production before this fix:
    // APIConnectionError/APIConnectionTimeoutError are themselves
    // subclasses of Anthropic.APIError with status undefined, so a naive
    // classifier that only checks `instanceof Anthropic.APIError` and then
    // switches on `.status` would silently fall through to
    // ChatAgentRequestFailedError with a null status -- indistinguishable
    // from "no HTTP response was ever received" using only the fields that
    // classifier produced.
    const connectionError = classifyAnthropicError(
      new Anthropic.APIConnectionError({ message: "Connection error." }),
    );
    const permanentHttpError = classifyAnthropicError(
      apiError(401, undefined, "authentication_error"),
    );
    expect(connectionError.category).not.toBe(permanentHttpError.category);
    expect(connectionError.status).toBeNull();
    expect(permanentHttpError.status).toBe(401);
  });

  it("captures errorConstructorName and causeConstructorName for connection failures -- plain class-name strings, never the raw message", () => {
    const connectionError = new Anthropic.APIConnectionError({
      message: "Connection error.",
      cause: new TypeError("fetch failed: node-fetch cannot open a raw socket in this runtime"),
    });
    const classified = classifyAnthropicError(connectionError);
    expect(classified).toBeInstanceOf(ChatAgentConnectionError);
    if (classified instanceof ChatAgentConnectionError) {
      expect(classified.errorConstructorName).toBe("APIConnectionError");
      expect(classified.causeConstructorName).toBe("TypeError");
      expect(classified.sdkVersion).toBe(ANTHROPIC_SDK_VERSION);
      expect(JSON.stringify(classified)).not.toContain("cannot open a raw socket");
    }
  });

  it("a connection error with no cause set still classifies correctly, with a null causeConstructorName", () => {
    const classified = classifyAnthropicError(
      new Anthropic.APIConnectionTimeoutError({ message: "Request timed out." }),
    );
    expect(classified).toBeInstanceOf(ChatAgentConnectionTimeoutError);
    if (classified instanceof ChatAgentConnectionTimeoutError) {
      expect(classified.causeConstructorName).toBeNull();
    }
  });

  it("isChatAgentConnectionError/isChatAgentConnectionTimeoutError type guards work via instanceof and via a duck-typed category fallback", () => {
    const realConnectionError = classifyAnthropicError(
      new Anthropic.APIConnectionError({ message: "Connection error." }),
    );
    expect(isChatAgentConnectionError(realConnectionError)).toBe(true);
    expect(isChatAgentConnectionTimeoutError(realConnectionError)).toBe(false);

    const realTimeoutError = classifyAnthropicError(new Anthropic.APIConnectionTimeoutError());
    expect(isChatAgentConnectionTimeoutError(realTimeoutError)).toBe(true);

    const duckTypedConnection = { category: "connection_failed" };
    expect(duckTypedConnection).not.toBeInstanceOf(ChatAgentConnectionError);
    expect(isChatAgentConnectionError(duckTypedConnection)).toBe(true);

    const duckTypedTimeout = { category: "connection_timeout" };
    expect(isChatAgentConnectionTimeoutError(duckTypedTimeout)).toBe(true);
  });
});

describe("error category discriminant (survives module-identity mismatches)", () => {
  it("every classified error carries a stable, JSON-serializable category string", () => {
    expect(new ChatAgentValidationError("x").category).toBe("validation");
    expect(classifyAnthropicError(apiError(429)).category).toBe("rate_limited");
    expect(classifyAnthropicError(apiError(529)).category).toBe("overloaded");
    expect(classifyAnthropicError(apiError(500)).category).toBe("provider_error");
    expect(classifyAnthropicError(apiError(401)).category).toBe("request_failed");
    expect(new ChatAgentResponseError("empty_response").category).toBe("response_error");
  });

  it("isChatAgentXError guards recognize the real class via instanceof (the common case)", () => {
    expect(isChatAgentValidationError(new ChatAgentValidationError("x"))).toBe(true);
    expect(isChatAgentRateLimitedError(classifyAnthropicError(apiError(429)))).toBe(true);
    expect(isChatAgentOverloadedError(classifyAnthropicError(apiError(529)))).toBe(true);
    expect(isChatAgentProviderError(classifyAnthropicError(apiError(500)))).toBe(true);
    expect(isChatAgentRequestFailedError(classifyAnthropicError(apiError(401)))).toBe(true);
    expect(isChatAgentResponseError(new ChatAgentResponseError("json_parse"))).toBe(true);
  });

  it("isChatAgentXError guards still classify a duck-typed object with a matching category even when instanceof fails", () => {
    // Simulates Cloudflare/OpenNext bundling producing two separate module
    // instances of this package -- a thrown error from one copy would fail
    // `instanceof` against the class imported from the other copy, even
    // though it is conceptually "the same" error. A plain object with the
    // right category string is the worst case of that: it has no prototype
    // link to the real class at all, yet the guard must still work.
    const duckTypedRateLimited = { name: "ChatAgentRateLimitedError", category: "rate_limited" };
    expect(duckTypedRateLimited).not.toBeInstanceOf(ChatAgentRateLimitedError);
    expect(isChatAgentRateLimitedError(duckTypedRateLimited)).toBe(true);

    const duckTypedResponseError = { name: "ChatAgentResponseError", category: "response_error" };
    expect(isChatAgentResponseError(duckTypedResponseError)).toBe(true);

    const duckTypedValidation = { category: "validation" };
    expect(isChatAgentValidationError(duckTypedValidation)).toBe(true);
  });

  it("isChatAgentXError guards reject an unrelated error/value regardless of shape", () => {
    expect(isChatAgentRateLimitedError(new Error("plain error"))).toBe(false);
    expect(isChatAgentRateLimitedError({ category: "overloaded" })).toBe(false);
    expect(isChatAgentRateLimitedError(null)).toBe(false);
    expect(isChatAgentRateLimitedError(undefined)).toBe(false);
    expect(isChatAgentRateLimitedError("a string")).toBe(false);
  });
});

describe("ChatAgentResponseError: stage and safe counts", () => {
  it("carries the failure stage and a character count, never response text", () => {
    const error = new ChatAgentResponseError("json_parse", { responseCharacterCount: 42 });
    expect(error.stage).toBe("json_parse");
    expect(error.responseCharacterCount).toBe(42);
    expect(error.validationIssueCount).toBeNull();
    expect(JSON.stringify(error)).not.toMatch(/rawText|responseText/);
  });

  it("carries a validation issue count for schema_validation, never the invalid field values", () => {
    const error = new ChatAgentResponseError("schema_validation", {
      responseCharacterCount: 120,
      validationIssueCount: 3,
    });
    expect(error.stage).toBe("schema_validation");
    expect(error.validationIssueCount).toBe(3);
  });
});
