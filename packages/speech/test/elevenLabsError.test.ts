import { describe, expect, it } from "vitest";
import {
  classifyElevenLabsStatus,
  ElevenLabsConfigurationError,
  validateElevenLabsApiKeyFormat,
} from "../src/providers/elevenLabsError.js";

describe("classifyElevenLabsStatus", () => {
  it.each([
    [401, "authentication_error", false],
    [403, "authentication_error", false],
    [429, "rate_limited", true],
    [500, "server_error", true],
    [502, "server_error", true],
    [503, "server_error", true],
    [400, "invalid_request", false],
    [404, "invalid_request", false],
    [422, "invalid_request", false],
  ] as const)("classifies status %i as %s (retryable: %s)", (status, category, retryable) => {
    expect(classifyElevenLabsStatus(status)).toEqual({ category, retryable });
  });
});

describe("validateElevenLabsApiKeyFormat (voice pipeline reliability phase 6)", () => {
  it("accepts a key with the expected sk_ prefix", () => {
    expect(() => validateElevenLabsApiKeyFormat("sk_abcdef1234567890")).not.toThrow();
  });

  it("rejects an empty key", () => {
    expect(() => validateElevenLabsApiKeyFormat("")).toThrow(ElevenLabsConfigurationError);
  });

  it("rejects a key missing the sk_ prefix", () => {
    expect(() => validateElevenLabsApiKeyFormat("abcdef1234567890")).toThrow(
      ElevenLabsConfigurationError,
    );
  });

  it("uses a generic, non-leaking error message -- never echoes the key value", () => {
    const badKey = "totally-wrong-format-key-12345";
    let caught: unknown;
    try {
      validateElevenLabsApiKeyFormat(badKey);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ElevenLabsConfigurationError);
    const message = (caught as Error).message;
    expect(message).toContain("voice_provider_configuration_error");
    expect(message).not.toContain(badKey);
  });
});
