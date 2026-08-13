import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the sixth live staging root cause, found from
 * post-deploy runtime diagnostics on the exact live test message ("Can you
 * research the Kerala market for competing digital marketing agencies?"):
 * researchRequired=true, researchEnabled=true, webSearchRequests=1,
 * sourceCount=5, stopReason="end_turn" -- research genuinely executed and
 * found real results -- yet the customer still received:
 *
 *   "I'm not able to research or share details about other agencies since
 *   I only have information on Dravonix Media's own services."
 *
 * Root cause: providers/anthropicProvider.ts computed
 * `researchEnabled = Boolean(input.researchEnabled) && !repairInstruction`
 * and passed that SAME flag into buildSystemPrompt for BOTH the WEB
 * RESEARCH section AND the SAFETY RULES company-scope carve-out. On a
 * repair attempt (triggered when the first attempt's response fails JSON/
 * schema validation -- e.g. a citation-heavy, multi-block response the
 * parser can't handle) this flag is forced false, so the SAFETY RULES
 * section reverts to the old unconditional "Do not discuss another
 * company's data; you only know about {company}." line -- even though
 * orchestrate.ts's buildRepairInstruction (fixed for the fourth live root
 * cause) appends the first attempt's real research findings as a user-turn
 * instruction telling the model to use them. Because the SAFETY RULES
 * section explicitly tells the model to disregard any customer/document
 * instruction that contradicts these rules, the model reliably obeys the
 * stricter system-prompt line over the repair instruction and refuses --
 * reproducing the exact live refusal. researchDiagnostics still reports the
 * FIRST attempt's successful search (sourceCount=5, webSearchRequests=1)
 * because orchestrate.ts always attaches `first.researchDiagnostics`
 * regardless of whether a repair happened, which is why the diagnostics
 * looked healthy while the customer-visible answer did not.
 *
 * The fix adds a new `researchFindingsAvailable` parameter to
 * buildSystemPrompt that gates ONLY the SAFETY RULES carve-out,
 * independent of `researchEnabled`/`researchRequired` (which still
 * correctly gate the full WEB RESEARCH section and tool re-attachment --
 * unchanged, since attaching that section's tool-usage instructions to a
 * call with no tool attached would itself be misleading).
 * anthropicProvider.ts now passes `Boolean(input.researchEnabled)`
 * (independent of `repairInstruction`) for this new parameter, so a repair
 * attempt for a turn where research already ran keeps the carve-out and no
 * longer contradicts the injected findings.
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

const OLD_UNCONDITIONAL_LINE = /Do not discuss another company's data; you only know about/i;
const CARVE_OUT_MARKER = /does NOT forbid discussing publicly available information/i;
const OBSERVED_REFUSAL =
  /I'm not able to research or share (details|info) about other agencies since I only have information on|only help with .* own services and pricing/i;

function malformedFirstAttempt() {
  return {
    content: [
      { type: "server_tool_use", id: "t1", name: "web_search", input: { query: "q" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "t1",
        content: [
          {
            type: "web_search_result",
            url: "https://example-industry.test/kerala-1",
            title: "Kerala digital marketing overview",
            encrypted_content: "opaque",
            page_age: "2 days ago",
          },
        ],
      },
      { type: "thinking", thinking: "Let me look at these results in detail..." },
      // Multiple fragmented text blocks that concatenate into something the
      // parser can't extract valid JSON from -- the same shape observed in
      // the live researchDiagnostics.responseBlockTypes (14 blocks, several
      // "text" entries, not one clean JSON object).
      { type: "text", text: "Based on the search results, several agencies operate in Kerala. " },
      { type: "text", text: '{"answer": "Several Kerala agencies offer SEO and paid ads' },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 200, output_tokens: 300, server_tool_use: { web_search_requests: 1 } },
  };
}

function repairSuccess(answer: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          answer,
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
  };
}

describe("6. Repair-attempt system prompt no longer contradicts injected research findings", () => {
  beforeEach(() => createMock.mockReset());

  it("first attempt finds real research but fails parsing -> repair call's OWN system prompt keeps the research carve-out instead of reverting to the unconditional company-only line", async () => {
    createMock
      .mockResolvedValueOnce(malformedFirstAttempt())
      .mockResolvedValueOnce(
        repairSuccess(
          "Several Kerala digital marketing agencies offer SEO, paid advertising, and social media services, based on current public listings.",
        ),
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

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(outcome.repaired).toBe(true);
    expect(outcome.usedFallback).toBe(false);

    // The exact regression: inspect the REPAIR call's own system prompt, not
    // just its message content.
    const repairCall = createMock.mock.calls[1]![0];
    const repairSystemPrompt = repairCall.system as string;
    expect(repairSystemPrompt).not.toMatch(OLD_UNCONDITIONAL_LINE);
    expect(repairSystemPrompt).toMatch(CARVE_OUT_MARKER);
    // The repair call still correctly never re-attaches the tool or the
    // full WEB RESEARCH section (unchanged behavior -- misleading to
    // include tool-usage instructions on a call with no tool attached).
    expect(repairCall.tools).toBeUndefined();
    expect(repairSystemPrompt).not.toContain("WEB RESEARCH (staging pilot");

    // researchDiagnostics still correctly reflect the first attempt's real
    // search (this was never broken -- included here so this test would
    // also fail if a future change broke that instead).
    expect(outcome.researchDiagnostics?.sourceCount).toBe(1);
    expect(outcome.researchDiagnostics?.webSearchRequests).toBe(1);

    // The actual customer-visible answer must be research-backed, never
    // the observed refusal.
    expect(outcome.response.answer).not.toMatch(OBSERVED_REFUSAL);
    expect(outcome.response.answer).toMatch(/kerala/i);
    expect(outcome.response.requiresHuman).toBe(false);
    expect(outcome.response.handoverReason).toBeNull();
  });

  it("researchEnabled=false: repair system prompt is unchanged (still the unconditional company-only line) -- non-research behavior fully preserved", async () => {
    createMock
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"answer": "incomplete json' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20 },
      })
      .mockResolvedValueOnce(
        repairSuccess("I'm not certain about that -- let me connect you with our team."),
      );

    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
    });

    await generateValidatedResponse(
      { provider },
      makeInput({ knowledge: [], customerMessage: "What are your prices?" }),
    );

    expect(createMock).toHaveBeenCalledTimes(2);
    const repairCall = createMock.mock.calls[1]![0];
    const repairSystemPrompt = repairCall.system as string;
    expect(repairSystemPrompt).toMatch(OLD_UNCONDITIONAL_LINE);
    expect(repairSystemPrompt).not.toMatch(CARVE_OUT_MARKER);
  });
});
