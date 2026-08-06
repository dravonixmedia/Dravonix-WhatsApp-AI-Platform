import { describe, expect, it } from "vitest";
import { AnthropicChatAgentProvider } from "../../src/chatAgent/provider.js";
import {
  isChatAgentConnectionError,
  isChatAgentConnectionTimeoutError,
} from "../../src/chatAgent/errors.js";

/**
 * Proves the confirmed staging fix: the Anthropic client must be
 * constructed with the Cloudflare/OpenNext runtime's own `fetch`
 * (globalThis.fetch), not the @anthropic-ai/sdk's auto-detected Node
 * fetch shim (node-fetch + agentkeepalive), which fails outright inside
 * the Workers sandbox (no raw TCP socket access) and surfaces as an
 * APIConnectionError with no HTTP status -- exactly what staging showed
 * (httpStatus: null, providerErrorType: null).
 *
 * There is no live network call here -- globalThis.fetch is temporarily
 * replaced with a local recorder for the duration of each test, and the
 * generated request is expected to fail against it (malformed/empty
 * response), which is fine: the only thing under test is *whether the SDK
 * routed the request through our fetch at all*. If the fetch binding were
 * ever removed, the SDK's own node-fetch would handle the request instead
 * and never touch globalThis.fetch, so calls would stay empty and this
 * test would correctly fail.
 */
describe("AnthropicChatAgentProvider: Cloudflare-native fetch binding", () => {
  it("routes its HTTP request through globalThis.fetch, not the SDK's own Node fetch shim", async () => {
    const calls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args);
      return new Response(JSON.stringify({ content: [], usage: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const provider = new AnthropicChatAgentProvider({
        apiKey: "test-key-not-real",
        model: "claude-sonnet-5",
        maxTokens: 100,
      });
      await provider.generateText("system prompt", "user message").catch(() => {
        // Only whether globalThis.fetch was invoked matters here -- the
        // stubbed response is deliberately minimal and may not satisfy the
        // SDK's own response parsing.
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.length).toBeGreaterThan(0);
  });

  it("a connection failure (globalThis.fetch itself throws, as it structurally could in a runtime without socket access) is classified as a connection error, not a generic request failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    try {
      const provider = new AnthropicChatAgentProvider({
        apiKey: "test-key-not-real",
        model: "claude-sonnet-5",
        maxTokens: 100,
      });
      await provider.generateText("system prompt", "user message");
      expect.unreachable("expected generateText to throw");
    } catch (error) {
      expect(isChatAgentConnectionError(error) || isChatAgentConnectionTimeoutError(error)).toBe(
        true,
      );
      if (isChatAgentConnectionError(error) || isChatAgentConnectionTimeoutError(error)) {
        expect(error.status).toBeNull();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
