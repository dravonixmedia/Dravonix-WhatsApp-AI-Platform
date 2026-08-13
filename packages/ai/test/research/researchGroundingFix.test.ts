import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the third live staging root cause: a genuinely
 * successful, cited research answer was silently forced into a handover by
 * safety.ts's ungrounded-claim rule, which only ever recognized
 * knowledgeSourceIds (company knowledge) as grounding -- never Anthropic's
 * own web-search citations, which by design (research/attribution.ts) must
 * never be merged into knowledgeSourceIds. A competitor/market-research
 * answer very plausibly mentions pricing or availability language (exactly
 * what UNGROUNDED_CLAIM_PATTERNS flags), so this defeated the research
 * feature for a large fraction of its own intended use cases even after the
 * deterministic-intent and pause_turn-continuation fixes.
 *
 * The fix adds a second, independent grounding signal (SafetyContext.
 * researchSourceCount, sourced from LiveResearchExecutionMetadata.findings.length
 * via orchestrate.ts) that safety.ts ORs with knowledgeSourceIds.length > 0.
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

function pausedServerToolUseOnly(query: string, id = "t1") {
  return {
    content: [{ type: "server_tool_use", id, name: "web_search", input: { query } }],
    stop_reason: "pause_turn",
    usage: { input_tokens: 400, output_tokens: 30 },
  };
}

describe("6. Exact live regression case -- successful research answer with a market pricing statement", () => {
  beforeEach(() => createMock.mockReset());

  it('research succeeds (source_count=3), answer contains "Several Kerala agencies publish packages in the ₹15,000/month range." -> requiresHuman=false, handoverReason=null, answer preserved', async () => {
    const RESEARCHED_ANSWER = {
      answer: "Several Kerala agencies publish packages in the ₹15,000/month range.",
      language: "en",
      intent: "market_research_question",
      confidence: 0.75,
      replyMode: "auto",
      leadUpdates: null,
      requiresHuman: false,
      handoverReason: null,
      // Correctly empty -- research citations must never be merged into
      // knowledgeSourceIds (research/attribution.ts).
      knowledgeSourceIds: [],
      internalNotes: null,
    };

    createMock
      .mockResolvedValueOnce(
        pausedServerToolUseOnly("Kerala digital marketing agencies competitors"),
      )
      .mockResolvedValueOnce({
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "t1",
            content: [
              {
                type: "web_search_result",
                url: "https://example-industry.test/kerala-1",
                title: "Kerala digital marketing pricing overview",
                encrypted_content: "opaque",
                page_age: "2 days ago",
              },
              {
                type: "web_search_result",
                url: "https://example-industry.test/kerala-2",
                title: "Kerala agency directory",
                encrypted_content: "opaque",
                page_age: "5 days ago",
              },
              {
                type: "web_search_result",
                url: "https://example-industry.test/kerala-3",
                title: "Kerala market research report",
                encrypted_content: "opaque",
                page_age: "1 week ago",
              },
            ],
          },
          {
            type: "text",
            text: JSON.stringify(RESEARCHED_ANSWER),
            citations: [
              {
                type: "web_search_result_location",
                url: "https://example-industry.test/kerala-1",
                title: "Kerala digital marketing pricing overview",
                cited_text: "packages in the ₹15,000/month range",
                encrypted_index: "idx",
              },
            ],
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 300 },
      });

    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    const outcome = await generateValidatedResponse(
      { provider, research: { enabled: true } },
      makeInput({
        knowledge: [],
        researchEnabled: true,
        customerMessage:
          "Can you research the Kerala market for competing digital marketing agencies?",
      }),
    );

    // Ground truth: research genuinely executed and produced 3 real findings.
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(outcome.repaired).toBe(false);
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.research?.searchesPerformed).toBe(1);
    expect(outcome.research?.findings.length).toBe(3);
    expect(outcome.research?.failureReason).toBeNull();

    // The actual regression assertion: research grounding must be respected.
    expect(outcome.response.requiresHuman).toBe(false);
    expect(outcome.response.handoverReason).toBeNull();
    expect(outcome.response.answer).toBe(RESEARCHED_ANSWER.answer);
    expect(outcome.response.confidence).toBe(RESEARCHED_ANSWER.confidence);
  });
});
