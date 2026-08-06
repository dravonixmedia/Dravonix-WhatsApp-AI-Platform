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
): Anthropic.APIError {
  return Anthropic.APIError.generate(status, { error: { message } }, message, undefined);
}

describe("classifyAnthropicError", () => {
  it("classifies a 429 (rate limited) error as ChatAgentRateLimitedError", () => {
    expect(classifyAnthropicError(apiError(429))).toBeInstanceOf(ChatAgentRateLimitedError);
  });

  it("classifies a 529 (overloaded) error as ChatAgentOverloadedError, distinct from 429", () => {
    const classified = classifyAnthropicError(apiError(529));
    expect(classified).toBeInstanceOf(ChatAgentOverloadedError);
    expect(classified).not.toBeInstanceOf(ChatAgentRateLimitedError);
  });

  it("classifies any other transient 5xx (e.g. 500, 503) as a generic ChatAgentProviderError", () => {
    expect(classifyAnthropicError(apiError(500))).toBeInstanceOf(ChatAgentProviderError);
    expect(classifyAnthropicError(apiError(503))).toBeInstanceOf(ChatAgentProviderError);
  });

  it("classifies a permanent 4xx (e.g. 401, 404) other than 429 as ChatAgentRequestFailedError", () => {
    expect(classifyAnthropicError(apiError(401))).toBeInstanceOf(ChatAgentRequestFailedError);
    expect(classifyAnthropicError(apiError(404))).toBeInstanceOf(ChatAgentRequestFailedError);
  });

  it("classifies a non-APIError (e.g. a network error) as a transient ChatAgentProviderError", () => {
    expect(classifyAnthropicError(new Error("ECONNRESET"))).toBeInstanceOf(ChatAgentProviderError);
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
