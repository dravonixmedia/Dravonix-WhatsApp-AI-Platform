import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the fourth live staging root cause, found via the
 * staging-only researchDiagnostics instrumentation on the exact live test
 * message ("Can you research the Kerala market for competing digital
 * marketing agencies?"): webSearchRequests=1 and sourceCount=5 (research
 * genuinely executed and found real results), yet the customer-facing reply
 * was still the research-blind refusal.
 *
 * Root cause: orchestrate.ts's repair path never re-attaches the web_search
 * tool (providers/anthropicProvider.ts) and rebuilds its message list fresh
 * from the original `input` -- it has no way to see whatever research the
 * first attempt already found. If a research-enabled first attempt found
 * real findings but still failed JSON/schema validation (e.g. a citation-
 * heavy, multi-block response the parser couldn't handle), the repair call
 * would reformulate an answer from nothing, with no company knowledge for a
 * market-research question -- honestly but unhelpfully reproducing exactly
 * the "I don't have market research data..." refusal reported live.
 *
 * The fix threads the first attempt's already-extracted, already-sanitized
 * research findings (research/anthropicWebSearch.ts's excerpt()s -- never
 * raw URLs or encrypted_content) into the repair instruction, so a repair
 * triggered on a research turn can still produce a real, research-backed
 * answer instead of a research-blind one.
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

describe("4. Repair path preserves real research findings instead of discarding them (staging live regression)", () => {
  beforeEach(() => createMock.mockReset());

  it("first attempt finds real research but fails JSON validation -> repair instruction carries the findings -> final answer is research-backed, not a research-blind refusal", async () => {
    // First (research-enabled) call: real search executed, real findings
    // returned (matching the live diagnostics: webSearchRequests=1,
    // sourceCount>0, stop_reason="end_turn", no pause_turn), but the final
    // text block is malformed/incomplete JSON -- the exact class of failure
    // that triggers orchestrate.ts's repair path.
    createMock
      .mockResolvedValueOnce({
        content: [
          { type: "server_tool_use", id: "t1", name: "web_search", input: { query: "q" } },
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
            ],
          },
          {
            type: "text",
            text: '{"answer": "Several Kerala agencies offer SEO and social',
            citations: [
              {
                type: "web_search_result_location",
                url: "https://example-industry.test/kerala-1",
                title: "Kerala digital marketing pricing overview",
                cited_text: "Several Kerala agencies offer SEO and social media packages",
                encrypted_index: "idx",
              },
            ],
          },
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 200,
          output_tokens: 300,
          server_tool_use: { web_search_requests: 1 },
        },
      })
      // Repair call (no web_search tool attached -- providers/anthropicProvider.ts
      // never attaches it to a repair attempt): with the fix, its instruction
      // now carries the real findings, so it can produce a research-backed answer.
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answer: "Several Kerala agencies offer SEO and social media packages.",
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
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 40 },
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

    // Ground truth: the first attempt genuinely found research, but failed validation.
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(outcome.repaired).toBe(true);
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.research?.findings.length).toBe(1);

    // The actual regression assertion: the repair call's own request must
    // carry the real findings forward -- never send the customer's message
    // again, but also never re-ask blind when research already succeeded.
    const repairCall = createMock.mock.calls[1]![0];
    const repairInstruction = repairCall.messages[repairCall.messages.length - 1].content as string;
    expect(repairInstruction).toContain("Kerala digital marketing pricing overview");
    expect(repairInstruction).toContain(
      "Several Kerala agencies offer SEO and social media packages",
    );
    // Sanitized: never the raw URL or encrypted_content.
    expect(repairInstruction).not.toContain("https://");
    expect(repairInstruction).not.toContain("opaque");
    // Repair call never carries the web_search tool (unchanged behavior).
    expect(repairCall.tools).toBeUndefined();

    // Final answer is research-backed, not the research-blind refusal.
    expect(outcome.response.answer).not.toMatch(
      /don'?t have (confirmed|specific|market research)/i,
    );
    expect(outcome.response.requiresHuman).toBe(false);
  });
});
