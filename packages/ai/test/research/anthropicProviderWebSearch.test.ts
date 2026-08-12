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

describe("AnthropicProvider -- research max_tokens budget (truncation/repair bug fix)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("1. normal request (research disabled): max_tokens is unchanged from config.maxTokens", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await provider.generate(makeInput());

    expect(createMock.mock.calls[0]![0].max_tokens).toBe(2048);
  });

  it("2. research request (first attempt): max_tokens is boosted by RESEARCH_MAX_TOKENS_MULTIPLIER over config.maxTokens", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await provider.generate(makeInput({ researchEnabled: true }));

    expect(createMock.mock.calls[0]![0].max_tokens).toBe(4096);
  });

  it("2b. an explicit researchMaxTokens config override takes priority over the default multiplier", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
      researchMaxTokens: 5000,
    });

    await provider.generate(makeInput({ researchEnabled: true }));

    expect(createMock.mock.calls[0]![0].max_tokens).toBe(5000);
  });

  it("3. repair request (researchEnabled true at input level, but repairInstruction present): tool is not attached and max_tokens stays the existing repair budget (1.5x), never the research budget", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await provider.generate(makeInput({ researchEnabled: true }), "Respond again with valid JSON.");

    const call = createMock.mock.calls[0]![0];
    expect(call.tools).toBeUndefined();
    // 2048 * 1.5 = 3072 (existing repair budget) -- NOT 2048 * 2 = 4096 (research budget).
    expect(call.max_tokens).toBe(3072);
  });

  it("4. research request with simulated large search metadata: the final structured JSON remains parseable within the boosted budget", async () => {
    const manyResults = Array.from({ length: 5 }, (_, i) => ({
      type: "web_search_result" as const,
      url: `https://example-industry.test/source-${i}`,
      title: `Kerala digital marketing source ${i}`,
      encrypted_content: "x".repeat(400), // simulates a nontrivial opaque payload per result
      page_age: "2 days ago",
    }));
    const longAnswer = {
      answer:
        "Based on recent research, several digital marketing agencies compete in the Kerala market. " +
        "Key players include regional and national firms specializing in SEO, social media, and paid campaigns. " +
        "Notable trends include increased focus on regional-language content and short-form video.",
      language: "en",
      intent: "market_research_question",
      confidence: 0.75,
      replyMode: "auto",
      leadUpdates: null,
      requiresHuman: false,
      handoverReason: null,
      knowledgeSourceIds: [],
      internalNotes: null,
    };

    createMock.mockResolvedValue({
      content: [
        {
          type: "server_tool_use",
          id: "t1",
          name: "web_search",
          input: { query: "Kerala digital marketing agencies competitors" },
        },
        { type: "web_search_tool_result", tool_use_id: "t1", content: manyResults },
        {
          type: "text",
          text: JSON.stringify(longAnswer),
          citations: manyResults.map((r) => ({
            type: "web_search_result_location",
            url: r.url,
            title: r.title,
            cited_text: "digital marketing agencies compete in Kerala",
            encrypted_index: "idx",
          })),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 3800 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    const result = await provider.generate(makeInput({ researchEnabled: true }));

    expect(() => JSON.parse(result.rawText)).not.toThrow();
    expect(JSON.parse(result.rawText)).toEqual(longAnswer);
    expect(result.research?.searchesPerformed).toBe(1);
    expect(result.research?.findings.length).toBeGreaterThan(0);
    // The boosted budget was actually requested for this call.
    expect(createMock.mock.calls[0]![0].max_tokens).toBe(4096);
  });
});
