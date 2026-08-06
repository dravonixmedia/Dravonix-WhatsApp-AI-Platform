import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  ChatAgentOverloadedError,
  ChatAgentProviderError,
  classifyAnthropicError,
} from "../../src/chatAgent/errors.js";

function apiError(
  status: number,
  message = "raw provider message that must never leak",
): Anthropic.APIError {
  return Anthropic.APIError.generate(status, { error: { message } }, message, undefined);
}

describe("classifyAnthropicError", () => {
  it("classifies a 529 (overloaded) error as ChatAgentOverloadedError", () => {
    expect(classifyAnthropicError(apiError(529))).toBeInstanceOf(ChatAgentOverloadedError);
  });

  it("classifies a 429 (rate limited) error as ChatAgentOverloadedError too", () => {
    expect(classifyAnthropicError(apiError(429))).toBeInstanceOf(ChatAgentOverloadedError);
  });

  it("classifies any other APIError (e.g. 401, 500) as a generic ChatAgentProviderError", () => {
    expect(classifyAnthropicError(apiError(401))).toBeInstanceOf(ChatAgentProviderError);
    expect(classifyAnthropicError(apiError(500))).toBeInstanceOf(ChatAgentProviderError);
  });

  it("classifies a non-APIError (e.g. a network error) as a generic ChatAgentProviderError", () => {
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
