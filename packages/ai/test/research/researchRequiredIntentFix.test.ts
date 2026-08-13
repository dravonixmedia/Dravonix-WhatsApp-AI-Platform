import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the deterministic research-intent fix: a
 * research-enabled AnthropicProvider call now forces web_search via
 * tool_choice whenever orchestrate.ts's deterministic detector
 * (research/intentDetector.ts) classifies the customer's current message as
 * an explicit research request, instead of relying solely on the model's
 * own judgment of the WEB RESEARCH prompt section's illustrative examples.
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

function textResponse(json: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe("AnthropicProvider -- forces tool_choice when researchRequired (test G/H)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("G. explicit research + research enabled -> the provider receives the research-required state and forces web_search via tool_choice", async () => {
    createMock.mockResolvedValue(textResponse({}));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await provider.generate(makeInput({ researchEnabled: true, researchRequired: true }));

    const call = createMock.mock.calls[0]![0];
    expect(call.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
    expect(call.tool_choice).toEqual({ type: "tool", name: "web_search" });
    expect(call.system).toContain("RESEARCH REQUIRED FOR THIS TURN");
  });

  it("does NOT force tool_choice when researchRequired is false (model keeps its own auto judgment)", async () => {
    createMock.mockResolvedValue(textResponse({}));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await provider.generate(makeInput({ researchEnabled: true, researchRequired: false }));

    const call = createMock.mock.calls[0]![0];
    expect(call.tool_choice).toBeUndefined();
    expect(call.system).not.toContain("RESEARCH REQUIRED FOR THIS TURN");
  });

  it("H. explicit research + research disabled -> safe non-research fallback: researchRequired has zero effect when researchEnabled is false", async () => {
    createMock.mockResolvedValue(textResponse({}));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await provider.generate(makeInput({ researchEnabled: false, researchRequired: true }));

    const call = createMock.mock.calls[0]![0];
    expect(call.tools).toBeUndefined();
    expect(call.tool_choice).toBeUndefined();
    expect(call.system).not.toContain("WEB RESEARCH");
    expect(call.system).not.toContain("RESEARCH REQUIRED FOR THIS TURN");
  });

  it("never forces tool_choice on a repair attempt, even when researchRequired was true on the original input", async () => {
    createMock.mockResolvedValue(textResponse({}));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await provider.generate(
      makeInput({ researchEnabled: true, researchRequired: true }),
      "Respond again with valid JSON.",
    );

    const call = createMock.mock.calls[0]![0];
    expect(call.tools).toBeUndefined();
    expect(call.tool_choice).toBeUndefined();
  });

  it("I. research failure -> no hallucinated answer even when the tool was forced", async () => {
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
      maxTokens: 2048,
    });

    const result = await provider.generate(
      makeInput({ researchEnabled: true, researchRequired: true }),
    );

    expect(result.research?.failureReason).toBe("provider_error");
    expect(result.research?.findings).toEqual([]);
    // No fabricated finding text -- the raw answer text is exactly what the
    // model produced when it honestly reported the failure.
    expect(result.rawText).toBe('{"answer": "I could not verify current information."}');
  });
});

describe("orchestrate.ts -- deterministic detection is wired into generateValidatedResponse (test G continued)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("an explicit research message with research enabled reaches the provider with researchRequired=true, forcing tool_choice, without the caller computing it itself", async () => {
    createMock.mockResolvedValue(textResponse({}));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await generateValidatedResponse(
      { provider, research: { enabled: true } },
      makeInput({
        knowledge: [],
        researchEnabled: true,
        customerMessage:
          "Can you research the Kerala market for competing digital marketing agencies?",
      }),
    );

    const call = createMock.mock.calls[0]![0];
    expect(call.tool_choice).toEqual({ type: "tool", name: "web_search" });
  });

  it("a plain company-service question with research enabled does NOT force tool_choice", async () => {
    createMock.mockResolvedValue(textResponse({}));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await generateValidatedResponse(
      { provider, research: { enabled: true } },
      makeInput({
        knowledge: [],
        researchEnabled: true,
        customerMessage: "What services do you provide?",
      }),
    );

    const call = createMock.mock.calls[0]![0];
    expect(call.tool_choice).toBeUndefined();
  });

  it("surfaces researchRequired/researchEnabled diagnostics via onExecuted even when the gate is disabled (operational visibility, item 5)", async () => {
    createMock.mockResolvedValue(textResponse({}));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });
    const onExecuted = vi.fn();

    await generateValidatedResponse(
      { provider, research: { enabled: false, onExecuted } },
      makeInput({
        knowledge: [],
        researchEnabled: false,
        customerMessage:
          "Can you research the Kerala market for competing digital marketing agencies?",
      }),
    );

    expect(onExecuted).toHaveBeenCalledTimes(1);
    const diagnostics = onExecuted.mock.calls[0]![0];
    expect(diagnostics.researchRequired).toBe(true);
    expect(diagnostics.researchEnabled).toBe(false);
    expect(diagnostics.researchStarted).toBe(false);
    expect(diagnostics.researchReason).toBe("research_disabled_for_company_or_environment");

    // Never stores customer message text, phone numbers, or raw content.
    expect(JSON.stringify(diagnostics)).not.toContain("Kerala");
  });

  it("does not call onExecuted at all for a normal question with research disabled and no research intent detected", async () => {
    createMock.mockResolvedValue(textResponse({}));
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });
    const onExecuted = vi.fn();

    await generateValidatedResponse(
      { provider, research: { enabled: false, onExecuted } },
      makeInput({ knowledge: [], researchEnabled: false }),
    );

    expect(onExecuted).not.toHaveBeenCalled();
  });

  it("includes researchRequired/researchEnabled fields when research is fully active and executed", async () => {
    createMock.mockResolvedValueOnce({
      content: [
        {
          type: "server_tool_use",
          id: "t1",
          name: "web_search",
          input: { query: "Kerala digital marketing agencies" },
        },
        {
          type: "web_search_tool_result",
          tool_use_id: "t1",
          content: [
            {
              type: "web_search_result",
              url: "https://example-industry.test/kerala",
              title: "Kerala digital marketing",
              encrypted_content: "opaque",
              page_age: null,
            },
          ],
        },
        {
          type: "text",
          text: JSON.stringify({
            answer: "Found some agencies.",
            language: "en",
            intent: "market_research_question",
            confidence: 0.7,
            replyMode: "auto",
            leadUpdates: null,
            requiresHuman: false,
            handoverReason: null,
            knowledgeSourceIds: [],
            internalNotes: null,
          }),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 200 },
    });
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
    expect(diagnostics.researchRequired).toBe(true);
    expect(diagnostics.researchEnabled).toBe(true);
    expect(diagnostics.researchStarted).toBe(true);
    expect(diagnostics.sourceCount).toBe(1);
  });
});

describe("7. Regression test -- reproduces the exact reported staging failure end to end", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('Input: "Can you research the Kerala market for competing digital marketing agencies?" -> researchRequired=true selects the forced research path instead of the old unknown/company fallback', async () => {
    const researchAnswer = {
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
        { type: "text", text: JSON.stringify(researchAnswer) },
      ],
      usage: { input_tokens: 500, output_tokens: 900 },
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

    // Proves the request the SDK actually received was deterministically
    // forced into the research path -- not left to model judgment.
    const call = createMock.mock.calls[0]![0];
    expect(call.tool_choice).toEqual({ type: "tool", name: "web_search" });

    // New expected behavior: research path selected, no fallback.
    expect(outcome.response.answer).toBe(researchAnswer.answer);
    expect(outcome.response.requiresHuman).toBe(false);
    expect(outcome.response.answer).not.toMatch(
      /I don't have (confirmed|specific) (details|market research data)/i,
    );
    expect(outcome.usedFallback).toBe(false);
  });
});
