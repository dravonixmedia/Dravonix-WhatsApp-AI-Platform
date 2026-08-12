import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the reported staging failure: a research-enabled
 * first attempt whose response (server_tool_use + web_search_tool_result +
 * citation-bearing text, all counted against the same max_tokens ceiling as
 * the JSON answer) needed more than the plain non-research budget (2048) to
 * finish -- which used to truncate the JSON, fail parsing, and fall through
 * to orchestrate.ts's repair attempt (intentionally research-blind:
 * no tool, no WEB RESEARCH prompt section), silently discarding the search
 * that was actually performed and producing a customer-facing
 * "I don't have market research data..." fallback.
 *
 * This exercises the REAL AnthropicProvider + the REAL generateValidatedResponse
 * (only the SDK's `messages.create` is mocked) to prove the fix end to end,
 * not just that a larger number gets passed to the API.
 */

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const { AnthropicProvider } = await import("../../src/providers/anthropicProvider.js");
const { generateValidatedResponse } = await import("../../src/orchestrate.js");
const { makeInput } = await import("../fixtures.js");

describe("5. Reproduces the previous failure scenario: boosted research budget avoids the blind repair fallback", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("a single-call research response whose content needs more than the plain 2048-token budget completes successfully -- no repair call, research result preserved", async () => {
    const answer = {
      answer:
        "Based on recent research, several digital marketing agencies compete in the Kerala market, " +
        "including regional SEO and social-media specialists alongside a few national firms with local offices.",
      language: "en",
      intent: "market_research_question",
      confidence: 0.7,
      replyMode: "auto",
      leadUpdates: null,
      requiresHuman: false,
      handoverReason: null,
      knowledgeSourceIds: [],
      internalNotes: null,
    };

    createMock.mockResolvedValueOnce({
      content: [
        {
          type: "server_tool_use",
          id: "t1",
          name: "web_search",
          input: { query: "Kerala digital marketing agencies competitors" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "t1",
          content: [
            {
              type: "web_search_result",
              url: "https://example-industry.test/kerala-digital",
              title: "Kerala digital marketing landscape",
              encrypted_content: "opaque",
              page_age: "2 days ago",
            },
          ],
        },
        {
          type: "text",
          text: JSON.stringify(answer),
          citations: [
            {
              type: "web_search_result_location",
              url: "https://example-industry.test/kerala-digital",
              title: "Kerala digital marketing landscape",
              cited_text: "several digital marketing agencies compete in the Kerala market",
              encrypted_index: "idx",
            },
          ],
        },
      ],
      // Reported output usage exceeds the plain 2048 non-research budget but
      // fits comfortably under the boosted 4096 research budget -- exactly
      // the band where the old code would have truncated and the new code
      // does not.
      usage: { input_tokens: 500, output_tokens: 3100 },
    });

    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    const outcome = await generateValidatedResponse(
      { provider, research: { enabled: true } },
      makeInput({ knowledge: [], researchEnabled: true }),
    );

    // Exactly one SDK call -- no repair attempt was triggered.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![0].max_tokens).toBe(4096);

    expect(outcome.repaired).toBe(false);
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.research?.searchesPerformed).toBe(1);
    expect(outcome.research?.findings.length).toBeGreaterThan(0);

    // The customer-facing answer is the research-grounded one, not a
    // research-blind "I don't have data" fallback.
    expect(outcome.response.answer).toBe(answer.answer);
    expect(outcome.response.requiresHuman).toBe(false);
  });
});
