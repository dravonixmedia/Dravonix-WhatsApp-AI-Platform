import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the second live staging root cause: Anthropic can
 * pause a long-running research turn (`stop_reason: "pause_turn"`) before it
 * produces a final answer. The pre-fix AnthropicProvider never inspected
 * `stop_reason` and treated whatever partial content came back (often empty)
 * as the final response -- which failed JSON parsing in orchestrate.ts and
 * fell through to the research-blind repair path, reproducing the exact
 * "I don't have market research data..." fallback reported live.
 *
 * The fix adds a bounded continuation loop per Anthropic's documented
 * server-tools contract: on `pause_turn`, re-send the paused assistant
 * `content` as-is (never fabricated, never client-executed) and keep
 * accumulating content/usage across every call that made up the turn.
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

const VALID_ANSWER = {
  answer:
    "Several digital marketing agencies compete in the Kerala market, including regional SEO and " +
    "social-media specialists alongside a few national firms with local offices.",
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

function textResponse(json: unknown, stopReason: string = "end_turn") {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function pausedServerToolUseOnly(query: string, id = "t1") {
  return {
    content: [{ type: "server_tool_use", id, name: "web_search", input: { query } }],
    stop_reason: "pause_turn",
    usage: { input_tokens: 400, output_tokens: 30 },
  };
}

function searchResultThenFinalText(
  toolUseId: string,
  url: string,
  stopReason: string = "end_turn",
) {
  return {
    content: [
      {
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: [
          {
            type: "web_search_result",
            url,
            title: "Kerala digital marketing landscape",
            encrypted_content: "opaque",
            page_age: "2 days ago",
          },
        ],
      },
      {
        type: "text",
        text: JSON.stringify(VALID_ANSWER),
        citations: [
          {
            type: "web_search_result_location",
            url,
            title: "Kerala digital marketing landscape",
            cited_text: "several digital marketing agencies compete in the Kerala market",
            encrypted_index: "idx",
          },
        ],
      },
    ],
    stop_reason: stopReason,
    usage: { input_tokens: 200, output_tokens: 300 },
  };
}

describe("AnthropicProvider -- pause_turn continuation", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("A. normal non-research response -- unchanged (no stop_reason handling engaged)", async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    const result = await provider.generate(makeInput());

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.rawText).toBe("{}");
    expect(result.research).toBeUndefined();
  });

  it("B. research response with no pause_turn -- unchanged, single call", async () => {
    createMock.mockResolvedValueOnce(textResponse(VALID_ANSWER, "end_turn"));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    const result = await provider.generate(
      makeInput({ researchEnabled: true, researchRequired: true }),
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.rawText)).toEqual(VALID_ANSWER);
    expect(result.research?.pauseTurnCount).toBe(0);
    expect(result.research?.researchContinuationCount).toBe(0);
  });

  it("C. one pause_turn -- exactly one continuation issued, final response returned", async () => {
    createMock
      .mockResolvedValueOnce(pausedServerToolUseOnly("Kerala digital marketing agencies"))
      .mockResolvedValueOnce(
        searchResultThenFinalText("t1", "https://example-industry.test/kerala"),
      );
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    const result = await provider.generate(
      makeInput({ researchEnabled: true, researchRequired: true }),
    );

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.rawText)).toEqual(VALID_ANSWER);
    expect(result.research?.pauseTurnCount).toBe(1);
    expect(result.research?.researchContinuationCount).toBe(1);
    expect(result.research?.failureReason).toBeNull();
  });

  it("D. two pause_turns -- exactly two continuations issued, final response returned", async () => {
    createMock
      .mockResolvedValueOnce(pausedServerToolUseOnly("Kerala digital marketing agencies", "t1"))
      .mockResolvedValueOnce(
        pausedServerToolUseOnly("Kerala digital marketing agencies refined", "t2"),
      )
      .mockResolvedValueOnce(
        searchResultThenFinalText("t2", "https://example-industry.test/kerala-2"),
      );
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    const result = await provider.generate(
      makeInput({ researchEnabled: true, researchRequired: true }),
    );

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(result.rawText)).toEqual(VALID_ANSWER);
    expect(result.research?.pauseTurnCount).toBe(2);
    expect(result.research?.researchContinuationCount).toBe(2);
  });

  it("E. a third consecutive pause_turn -- hard stop at the bound, typed failure, no infinite loop", async () => {
    createMock
      .mockResolvedValueOnce(pausedServerToolUseOnly("q1", "t1"))
      .mockResolvedValueOnce(pausedServerToolUseOnly("q2", "t2"))
      .mockResolvedValueOnce(pausedServerToolUseOnly("q3", "t3"));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    const result = await provider.generate(
      makeInput({ researchEnabled: true, researchRequired: true }),
    );

    // Initial call + exactly MAX_SERVER_TOOL_CONTINUATIONS (2) continuations -- never a 4th call.
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(result.research?.pauseTurnCount).toBe(2);
    expect(result.research?.researchContinuationCount).toBe(2);
    // Typed research failure -- not silently converted into a normal successful answer.
    expect(result.research?.failureReason).toBe("provider_timeout");
    // No fabricated answer: rawText reflects whatever (empty) text actually came back.
    expect(result.rawText).toBe("");
  });

  it("F. the exact paused assistant content is preserved verbatim in the continuation request", async () => {
    const pausedResponse = pausedServerToolUseOnly("Kerala digital marketing agencies");
    createMock
      .mockResolvedValueOnce(pausedResponse)
      .mockResolvedValueOnce(
        searchResultThenFinalText("t1", "https://example-industry.test/kerala"),
      );
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await provider.generate(makeInput({ researchEnabled: true, researchRequired: true }));

    const continuationCall = createMock.mock.calls[1]![0];
    const lastMessage = continuationCall.messages[continuationCall.messages.length - 1];
    expect(lastMessage.role).toBe("assistant");
    // Exact content, not reconstructed or filtered -- same array reference contents.
    expect(lastMessage.content).toEqual(pausedResponse.content);
  });

  it("G. pause_turn followed by web_search_tool_result + final text -- research metadata combines both segments and final JSON parses", async () => {
    createMock
      .mockResolvedValueOnce(pausedServerToolUseOnly("Kerala digital marketing agencies"))
      .mockResolvedValueOnce(
        searchResultThenFinalText("t1", "https://example-industry.test/kerala"),
      );
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    const result = await provider.generate(
      makeInput({ researchEnabled: true, researchRequired: true }),
    );

    // The search query came from segment 1 (before the pause); the result and
    // citation came from segment 2 (after the continuation) -- both must be
    // present in the combined metadata.
    expect(result.research?.searchesPerformed).toBe(1);
    expect(result.research?.searchQueries).toEqual(["Kerala digital marketing agencies"]);
    expect(result.research?.findings.length).toBeGreaterThan(0);
    expect(() => JSON.parse(result.rawText)).not.toThrow();
    expect(JSON.parse(result.rawText)).toEqual(VALID_ANSWER);
  });

  it("I. max_uses=3 tool config remains identical across every continuation call", async () => {
    createMock
      .mockResolvedValueOnce(pausedServerToolUseOnly("q1", "t1"))
      .mockResolvedValueOnce(
        searchResultThenFinalText("t1", "https://example-industry.test/kerala"),
      );
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await provider.generate(makeInput({ researchEnabled: true, researchRequired: true }));

    for (const call of createMock.mock.calls) {
      expect(call[0].tools).toEqual([
        { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      ]);
      expect(call[0].tool_choice).toEqual({ type: "tool", name: "web_search" });
    }
  });
});

describe("generateValidatedResponse -- repair only runs after the continuation budget is exhausted (test H)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("H1. a pause_turn resolved within the continuation budget does NOT trigger orchestrate.ts repair", async () => {
    createMock
      .mockResolvedValueOnce(pausedServerToolUseOnly("Kerala digital marketing agencies"))
      .mockResolvedValueOnce(
        searchResultThenFinalText("t1", "https://example-industry.test/kerala"),
      );
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

    // Exactly the 2 research calls -- no 3rd (repair) call.
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(outcome.repaired).toBe(false);
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.response.answer).toBe(VALID_ANSWER.answer);
  });

  it("H2. a research turn that exhausts the continuation budget DOES fall through to the existing repair path", async () => {
    createMock
      .mockResolvedValueOnce(pausedServerToolUseOnly("q1", "t1"))
      .mockResolvedValueOnce(pausedServerToolUseOnly("q2", "t2"))
      .mockResolvedValueOnce(pausedServerToolUseOnly("q3", "t3"))
      // 4th call is orchestrate.ts's repair attempt (no tool, no pause_turn handling relevant).
      .mockResolvedValueOnce(
        textResponse({
          answer:
            "I don't have market research data on competing agencies in Kerala to share. I can connect you with our team to discuss your business goals instead. Would you like me to arrange that?",
          language: "en",
          intent: "market_research_question",
          confidence: 0.3,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: true,
          handoverReason: "missing_knowledge_grounding",
          knowledgeSourceIds: [],
          internalNotes: null,
        }),
      );
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

    // 3 research calls (initial + 2 continuations) + 1 repair call.
    expect(createMock).toHaveBeenCalledTimes(4);
    expect(outcome.repaired).toBe(true);
    expect(outcome.research?.failureReason).toBe("provider_timeout");
    expect(outcome.research?.researchContinuationCount).toBe(2);
    // Repair's own request never carries the web_search tool.
    expect(createMock.mock.calls[3]![0].tools).toBeUndefined();
  });
});

describe("orchestrate.ts diagnostics -- continuation counts reported (test J)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("onExecuted receives the exact pauseTurnCount/researchContinuationCount for a multi-continuation turn", async () => {
    createMock
      .mockResolvedValueOnce(pausedServerToolUseOnly("q1", "t1"))
      .mockResolvedValueOnce(pausedServerToolUseOnly("q2", "t2"))
      .mockResolvedValueOnce(
        searchResultThenFinalText("t2", "https://example-industry.test/kerala"),
      );
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });
    const onExecuted = vi.fn();

    await generateValidatedResponse(
      { provider, research: { enabled: true, onExecuted } },
      makeInput({
        knowledge: [],
        researchEnabled: true,
        customerMessage:
          "Can you research the Kerala market for competing digital marketing agencies?",
      }),
    );

    expect(onExecuted).toHaveBeenCalledTimes(1);
    const diagnostics = onExecuted.mock.calls[0]![0];
    expect(diagnostics.pauseTurnCount).toBe(2);
    expect(diagnostics.researchContinuationCount).toBe(2);
    expect(diagnostics.researchCompleted).toBe(true);
  });
});

describe("8. Exact staging-bug regression fixture -- fails on the pre-fix implementation, passes on the fix", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('Input: "Can you research the Kerala market for competing digital marketing agencies?" with a paused server-side search -> continuation -> complete final JSON, no blind repair, research answer preserved', async () => {
    // This exact response sequence is what the live staging failure's root
    // cause looked like: the first response pauses mid-search with nothing
    // usable yet. The pre-fix provider returned rawText="" straight from
    // this single response, which orchestrate.ts's tryParse() failed on,
    // triggering the research-blind repair fallback -- reproduced and
    // proven in the prior diagnostic turn's temporary test. The fix adds
    // the continuation call that actually finishes the turn.
    createMock
      .mockResolvedValueOnce(
        pausedServerToolUseOnly("Kerala digital marketing agencies competitors"),
      )
      .mockResolvedValueOnce(
        searchResultThenFinalText("t1", "https://example-industry.test/kerala-digital"),
      );

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

    // No blind repair: exactly the 2 research calls, no 3rd call.
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(outcome.repaired).toBe(false);
    expect(outcome.usedFallback).toBe(false);

    // Complete final JSON, research answer preserved -- not the fallback text.
    expect(outcome.response.answer).toBe(VALID_ANSWER.answer);
    expect(outcome.response.requiresHuman).toBe(false);
    expect(outcome.response.answer).not.toMatch(
      /I don't have (confirmed|specific) (details|market research data)/i,
    );
    expect(outcome.research?.searchesPerformed).toBe(1);
    expect(outcome.research?.findings.length).toBeGreaterThan(0);
  });
});
