import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the fifth live staging root cause, found after
 * five consecutive fresh-number live tests all reproduced the same refusal:
 * "I'm not able to research or share info about other agencies since I can
 * only help with Dravonix Media's own services and pricing."
 *
 * Root cause: buildSystemPrompt.ts's SAFETY RULES section (always included,
 * unconditional, positioned BEFORE the WEB RESEARCH section) contained
 * "Do not discuss another company's data; you only know about
 * {companyName}." -- framed as an inviolable rule ("SAFETY RULES (never
 * violate these...)"), this predates DRAIVA Research and silently overrode
 * every explicit research-action-request instruction later in the same
 * prompt for any question that mentions another company/competitor/agency,
 * exactly reproducing the observed refusal wording.
 *
 * The fix reframes this rule at its source (packages/ai/src/prompt/
 * buildSystemPrompt.ts): the underlying goal -- never fabricate a specific,
 * non-public fact about another company as if confirmed -- is preserved
 * unconditionally, but when researchEnabled is true (never in production)
 * it explicitly carves out publicly-researched information for explicit
 * research/investigation/comparison/competitor-analysis requests, deferring
 * to the WEB RESEARCH section. Two intent-detector gaps found in the same
 * audit (research/intentDetector.ts) are also closed: "Who are our
 * competitors?" (no verb keyword) and a research imperative appearing
 * mid-message after context ("Imagine we are an interior fit-out company.
 * Research the Kerala market...") -- the prior anchor only matched a verb
 * at the very start of the whole message.
 */

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const { AnthropicProvider } = await import("../../src/providers/anthropicProvider.js");
const { generateValidatedResponse } = await import("../../src/orchestrate.js");
const { detectResearchIntent } = await import("../../src/research/intentDetector.js");
const { makeInput } = await import("../fixtures.js");

function researchAnswer(overrides: Record<string, unknown> = {}) {
  return {
    answer: "Several Kerala agencies offer SEO, paid advertising, and social media services.",
    language: "en",
    intent: "market_research_question",
    confidence: 0.75,
    replyMode: "auto",
    leadUpdates: null,
    requiresHuman: false,
    handoverReason: null,
    knowledgeSourceIds: [],
    internalNotes: null,
    ...overrides,
  };
}

function researchToolResponse(
  answer: Record<string, unknown>,
  sources: Array<{ url: string; title: string }>,
) {
  return {
    content: [
      { type: "server_tool_use", id: "t1", name: "web_search", input: { query: "q" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "t1",
        content: sources.map((s) => ({
          type: "web_search_result",
          url: s.url,
          title: s.title,
          encrypted_content: "opaque",
          page_age: "2 days ago",
        })),
      },
      { type: "text", text: JSON.stringify(answer) },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 200, output_tokens: 300, server_tool_use: { web_search_requests: 1 } },
  };
}

describe("A-F. detectResearchIntent -- company-fact vs research-action classification", () => {
  it("A. 'What services do you provide?' -> not a research request", () => {
    expect(detectResearchIntent("What services do you provide?").researchRequired).toBe(false);
  });

  it("C. 'What are the latest digital marketing trends in Kerala?' -> research", () => {
    expect(
      detectResearchIntent("What are the latest digital marketing trends in Kerala?")
        .researchRequired,
    ).toBe(true);
  });

  it("D. 'Who are our competitors?' -> research", () => {
    expect(detectResearchIntent("Who are our competitors?").researchRequired).toBe(true);
  });

  it("E. 'Do you offer market research as a service?' -> service-capability question, not research", () => {
    expect(
      detectResearchIntent("Do you offer market research as a service?").researchRequired,
    ).toBe(false);
  });

  it("F. research imperative mid-message (after customer-supplied context) -> research", () => {
    expect(
      detectResearchIntent(
        "Imagine we are an interior fit-out company. Research the Kerala market for competing interior fit-out agencies.",
      ).researchRequired,
    ).toBe(true);
  });
});

describe("8. Exact screenshot regression -- the system prompt no longer contains the unconditional scope restriction", () => {
  beforeEach(() => createMock.mockReset());

  it('system prompt for "Can you research the Kerala market for competing digital marketing agencies?" carves out research from the company-scope safety rule instead of blocking it', async () => {
    createMock.mockResolvedValueOnce(
      researchToolResponse(researchAnswer(), [
        {
          url: "https://example-industry.test/kerala-1",
          title: "Kerala digital marketing overview",
        },
      ]),
    );
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

    const systemPrompt = createMock.mock.calls[0]![0].system as string;
    // The old unconditional line must be gone from a research-enabled call.
    expect(systemPrompt).not.toMatch(/Do not discuss another company's data; you only know about/i);
    // The reframed rule must explicitly carve out research.
    expect(systemPrompt).toMatch(/does NOT forbid discussing publicly available information/i);
  });
});

describe("B/G/H/I/J. Full pipeline -- research is allowed to complete and answer, never silently discarded", () => {
  beforeEach(() => createMock.mockReset());

  it("B. research action request produces a research-backed answer, not the observed refusal", async () => {
    createMock.mockResolvedValueOnce(
      researchToolResponse(researchAnswer(), [
        {
          url: "https://example-industry.test/kerala-1",
          title: "Kerala digital marketing overview",
        },
      ]),
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

    expect(outcome.response.answer).not.toMatch(
      /only help with .* own services and pricing|not able to research/i,
    );
    expect(outcome.response.requiresHuman).toBe(false);
    expect(outcome.research?.findings.length).toBeGreaterThan(0);
  });

  it("G. research findings mentioning competitor pricing do not trigger an incorrect grounding handover", async () => {
    createMock.mockResolvedValueOnce(
      researchToolResponse(
        researchAnswer({
          answer: "Several Kerala agencies publish packages in the ₹15,000/month range.",
        }),
        [{ url: "https://example-industry.test/kerala-1", title: "Kerala pricing overview" }],
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

    expect(outcome.research?.findings.length).toBeGreaterThan(0);
    expect(outcome.response.requiresHuman).toBe(false);
    expect(outcome.response.handoverReason).toBeNull();
  });

  it("H. web_search genuinely fails -> honest, safe fallback (requiresHuman=true is legitimate here)", async () => {
    createMock.mockResolvedValueOnce({
      content: [
        { type: "server_tool_use", id: "t1", name: "web_search", input: { query: "q" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "t1",
          content: { type: "web_search_tool_result_error", error_code: "unavailable" },
        },
        {
          type: "text",
          text: JSON.stringify(
            researchAnswer({
              answer:
                "I searched for current information but wasn't able to find reliable results just now. I can connect you with our team instead.",
              requiresHuman: true,
              handoverReason: "web_search_no_results",
            }),
          ),
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 200, output_tokens: 150 },
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

    expect(outcome.research?.findings.length).toBe(0);
    expect(outcome.response.requiresHuman).toBe(true);
    expect(outcome.repaired).toBe(false);
  });

  it("I. Spanish research request -> researchRequired detected, tool forced, Spanish answer preserved", async () => {
    createMock.mockResolvedValueOnce(
      researchToolResponse(
        researchAnswer({
          answer: "Varias agencias de Kerala ofrecen SEO, publicidad y redes sociales.",
          language: "es",
        }),
        [{ url: "https://example-industry.test/kerala-1", title: "Resumen de Kerala" }],
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
        customerMessage: "¿Puedes investigar el mercado de Kerala para agencias competidoras?",
      }),
    );

    const call = createMock.mock.calls[0]![0];
    expect(call.tool_choice).toEqual({ type: "tool", name: "web_search" });
    expect(outcome.response.language).toBe("es");
    expect(outcome.response.requiresHuman).toBe(false);
  });

  it("J. Arabic research request -> researchRequired detected, tool forced, Arabic answer preserved", async () => {
    createMock.mockResolvedValueOnce(
      researchToolResponse(
        researchAnswer({
          answer: "تقدم عدة وكالات في كيرلا خدمات تحسين محركات البحث والإعلانات ووسائل التواصل.",
          language: "ar",
        }),
        [{ url: "https://example-industry.test/kerala-1", title: "نظرة عامة على كيرلا" }],
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
        customerMessage: "هل يمكنك أن ابحث عن السوق في كيرالا للوكالات المنافسة؟",
      }),
    );

    const call = createMock.mock.calls[0]![0];
    expect(call.tool_choice).toEqual({ type: "tool", name: "web_search" });
    expect(outcome.response.language).toBe("ar");
    expect(outcome.response.requiresHuman).toBe(false);
  });
});
