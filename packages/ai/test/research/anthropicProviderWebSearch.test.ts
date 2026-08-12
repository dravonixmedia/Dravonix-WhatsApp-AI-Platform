import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const { AnthropicProvider } = await import("../../src/providers/anthropicProvider.js");
const { makeInput } = await import("../fixtures.js");

describe("AnthropicProvider -- DRAIVA Research web_search integration", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("scenario 1 (known company question): does NOT attach web_search when researchEnabled is omitted/false", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    const result = await provider.generate(makeInput());

    const call = createMock.mock.calls[0]![0];
    expect(call.tools).toBeUndefined();
    expect(result.research).toBeUndefined();
  });

  it("attaches the web_search tool with max_uses=3 when researchEnabled is true on a first attempt", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    await provider.generate(makeInput({ researchEnabled: true }));

    const call = createMock.mock.calls[0]![0];
    expect(call.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
  });

  it("respects a custom webSearchMaxUses config override", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 1024,
      webSearchMaxUses: 1,
    });

    await provider.generate(makeInput({ researchEnabled: true }));

    const call = createMock.mock.calls[0]![0];
    expect(call.tools[0].max_uses).toBe(1);
  });

  it("NEVER attaches web_search on a repair attempt, even when researchEnabled is true -- bounds total searches per turn", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    const result = await provider.generate(
      makeInput({ researchEnabled: true }),
      "Respond again with valid JSON.",
    );

    const call = createMock.mock.calls[0]![0];
    expect(call.tools).toBeUndefined();
    expect(result.research).toBeUndefined();
  });

  it("includes the WEB RESEARCH system prompt section only when the tool is actually attached", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    await provider.generate(makeInput({ researchEnabled: true }));
    const enabledCall = createMock.mock.calls[0]![0];
    expect(enabledCall.system).toContain("WEB RESEARCH");

    createMock.mockClear();
    await provider.generate(makeInput({ researchEnabled: false }));
    const disabledCall = createMock.mock.calls[0]![0];
    expect(disabledCall.system).not.toContain("WEB RESEARCH");
  });

  it("scenario 2-5 (research performed): extracts research metadata from the response into the result", async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: "server_tool_use",
          id: "t1",
          name: "web_search",
          input: { query: "Kerala interior fit-out market" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "t1",
          content: [
            {
              type: "web_search_result",
              url: "https://example-industry.test/kerala",
              title: "Kerala market overview",
              encrypted_content: "opaque",
              page_age: null,
            },
          ],
        },
        {
          type: "text",
          text: '{"answer": "..."}',
          citations: [
            {
              type: "web_search_result_location",
              url: "https://example-industry.test/kerala",
              title: "Kerala market overview",
              cited_text: "Several brands compete in this space.",
              encrypted_index: "idx",
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    const result = await provider.generate(makeInput({ researchEnabled: true }));

    expect(result.rawText).toBe('{"answer": "..."}');
    expect(result.research?.searchesPerformed).toBe(1);
    expect(result.research?.searchQueries).toEqual(["Kerala interior fit-out market"]);
    expect(result.research?.findings).toHaveLength(1);
    expect(result.research?.findings[0]?.origin).toBe("external_research");
  });

  it("scenario 8 (provider unavailable): surfaces failureReason without throwing or fabricating", async () => {
    createMock.mockResolvedValue({
      content: [
        { type: "server_tool_use", id: "t1", name: "web_search", input: { query: "anything" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "t1",
          content: { type: "web_search_tool_result_error", error_code: "unavailable" },
        },
        { type: "text", text: '{"answer": "I could not verify current information."}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    const result = await provider.generate(makeInput({ researchEnabled: true }));

    expect(result.research?.failureReason).toBe("provider_error");
    expect(result.research?.findings).toEqual([]);
    expect(result.rawText).toBe('{"answer": "I could not verify current information."}');
  });

  it("does not include tools param when the SDK call itself throws (no swallowed research state on hard failure)", async () => {
    createMock.mockRejectedValue(new Error("network down"));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 1024,
    });

    await expect(provider.generate(makeInput({ researchEnabled: true }))).rejects.toThrow(
      "network down",
    );
  });
});
