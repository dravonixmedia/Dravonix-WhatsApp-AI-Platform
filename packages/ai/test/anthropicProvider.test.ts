import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const { AnthropicProvider } = await import("../src/providers/anthropicProvider.js");
const { makeInput } = await import("./fixtures.js");

describe("AnthropicProvider", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  it("substitutes a placeholder for a recent message with empty body instead of sending empty content", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    const input = makeInput({
      memory: {
        recentMessages: [{ role: "customer", body: "" }],
        summary: null,
        leadState: {},
        unresolvedQuestions: [],
        customerReplyPreference: null,
        lastDetectedLanguage: null,
      },
    });

    await provider.generate(input);

    expect(createMock).toHaveBeenCalledTimes(1);
    const call = createMock.mock.calls[0]![0];
    expect(call.messages[0].content).not.toBe("");
    expect(call.messages[0].content.length).toBeGreaterThan(0);
  });

  it("passes a non-empty recent message body through unchanged", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    const input = makeInput({
      memory: {
        recentMessages: [{ role: "customer", body: "hello there" }],
        summary: null,
        leadState: {},
        unresolvedQuestions: [],
        customerReplyPreference: null,
        lastDetectedLanguage: null,
      },
    });

    await provider.generate(input);

    const call = createMock.mock.calls[0]![0];
    expect(call.messages[0].content).toBe("hello there");
  });

  it("uses the configured max_tokens for a first attempt", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    await provider.generate(makeInput());

    expect(createMock.mock.calls[0]![0].max_tokens).toBe(1024);
  });

  it("boosts max_tokens for a repair attempt, since truncation is a likely cause of the first failure", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    await provider.generate(makeInput(), "Respond again with valid JSON.");

    expect(createMock.mock.calls[0]![0].max_tokens).toBe(1536);
  });
});
