import { describe, expect, it } from "vitest";
import {
  buildActionInstruction,
  isStructuredAction,
  parseActionResponse,
  validateChatAgentInput,
} from "../../src/chatAgent/actions.js";
import { ChatAgentResponseError, ChatAgentValidationError } from "../../src/chatAgent/errors.js";
import type { ChatAgentInput } from "../../src/chatAgent/types.js";

function baseInput(overrides: Partial<ChatAgentInput> = {}): ChatAgentInput {
  return {
    action: "summarize",
    messages: [],
    historyTruncated: false,
    company: {
      companyName: "Dravonix Media",
      tone: "friendly_professional",
      enabledLanguages: ["en", "ml"],
      fallbackLanguage: "en",
      restrictedTopics: [],
    },
    conversation: { state: "human_active", aiMode: "active" },
    contact: null,
    lead: null,
    ...overrides,
  };
}

describe("validateChatAgentInput", () => {
  it("requires a draft for rewrite_draft", () => {
    expect(() =>
      validateChatAgentInput(baseInput({ action: "rewrite_draft", tone: "friendly" })),
    ).toThrow(ChatAgentValidationError);
  });

  it("requires a tone for rewrite_draft", () => {
    expect(() =>
      validateChatAgentInput(baseInput({ action: "rewrite_draft", staffDraft: "hello" })),
    ).toThrow(ChatAgentValidationError);
  });

  it("passes rewrite_draft with both draft and tone", () => {
    expect(() =>
      validateChatAgentInput(
        baseInput({ action: "rewrite_draft", staffDraft: "hello", tone: "friendly" }),
      ),
    ).not.toThrow();
  });

  it("requires draft text and a supported target language for translate", () => {
    expect(() => validateChatAgentInput(baseInput({ action: "translate" }))).toThrow(
      ChatAgentValidationError,
    );
    expect(() =>
      validateChatAgentInput(baseInput({ action: "translate", staffDraft: "hi" })),
    ).toThrow(ChatAgentValidationError);
    expect(() =>
      validateChatAgentInput(
        baseInput({
          action: "translate",
          staffDraft: "hi",
          targetLanguage: "fr" as ChatAgentInput["targetLanguage"],
        }),
      ),
    ).toThrow(ChatAgentValidationError);
    expect(() =>
      validateChatAgentInput(
        baseInput({ action: "translate", staffDraft: "hi", targetLanguage: "ml" }),
      ),
    ).not.toThrow();
  });

  it("requires a question for ask_question", () => {
    expect(() => validateChatAgentInput(baseInput({ action: "ask_question" }))).toThrow(
      ChatAgentValidationError,
    );
    expect(() =>
      validateChatAgentInput(baseInput({ action: "ask_question", question: "What service?" })),
    ).not.toThrow();
  });

  it("never requires extra fields for summarize/suggest_reply/extract_lead/prepare_follow_up", () => {
    for (const action of [
      "summarize",
      "suggest_reply",
      "extract_lead",
      "prepare_follow_up",
    ] as const) {
      expect(() => validateChatAgentInput(baseInput({ action }))).not.toThrow();
    }
  });
});

describe("isStructuredAction", () => {
  it("is true only for summarize and extract_lead", () => {
    expect(isStructuredAction("summarize")).toBe(true);
    expect(isStructuredAction("extract_lead")).toBe(true);
    expect(isStructuredAction("suggest_reply")).toBe(false);
    expect(isStructuredAction("rewrite_draft")).toBe(false);
    expect(isStructuredAction("translate")).toBe(false);
    expect(isStructuredAction("prepare_follow_up")).toBe(false);
    expect(isStructuredAction("ask_question")).toBe(false);
  });
});

describe("buildActionInstruction", () => {
  it("suggest_reply instructs the model never to confirm an unproven meeting/callback/team notification", () => {
    const instruction = buildActionInstruction(baseInput({ action: "suggest_reply" }));
    expect(instruction).toMatch(/do not promise/i);
    expect(instruction).toMatch(/unless the context above already proves/i);
  });

  it("rewrite_draft embeds the staff draft and the requested tone, and forbids adding commitments", () => {
    const instruction = buildActionInstruction(
      baseInput({ action: "rewrite_draft", staffDraft: "we can do it", tone: "persuasive" }),
    );
    expect(instruction).toContain("we can do it");
    expect(instruction).toContain("persuasive");
    expect(instruction).toMatch(/do not add or remove any promise, price, date/i);
  });

  it("translate embeds the draft text and instructs preserving names/prices/dates/links", () => {
    const instruction = buildActionInstruction(
      baseInput({
        action: "translate",
        staffDraft: "Call us at +911234567890",
        targetLanguage: "hi",
      }),
    );
    expect(instruction).toContain("Call us at +911234567890");
    expect(instruction).toMatch(/Hindi/);
    expect(instruction).toMatch(/preserve names, prices, dates, phone numbers, urls/i);
  });

  it("ask_question embeds the staff question and forbids general knowledge/internet search", () => {
    const instruction = buildActionInstruction(
      baseInput({ action: "ask_question", question: "Did they mention a budget?" }),
    );
    expect(instruction).toContain("Did they mention a budget?");
    expect(instruction).toMatch(/never general knowledge/i);
    expect(instruction).toMatch(/internet search/i);
    expect(instruction).toContain("This information is not present in the available conversation.");
  });

  it("summarize and extract_lead request a single JSON object with no markdown fences", () => {
    for (const action of ["summarize", "extract_lead"] as const) {
      const instruction = buildActionInstruction(baseInput({ action }));
      expect(instruction).toMatch(/ONLY a single JSON object/i);
      expect(instruction).toMatch(/no markdown fences/i);
      expect(instruction).toContain('"Not provided"');
    }
  });
});

describe("parseActionResponse", () => {
  it("trims and returns free-text responses as-is", () => {
    const result = parseActionResponse("suggest_reply", "  Sure, happy to help!  ");
    expect(result.displayText).toBe("Sure, happy to help!");
    expect(result.structured).toBeUndefined();
  });

  it("throws ChatAgentResponseError for an empty free-text response", () => {
    expect(() => parseActionResponse("suggest_reply", "   ")).toThrow(ChatAgentResponseError);
  });

  it("parses a valid summarize JSON response and formats it into readable labeled text", () => {
    const raw = JSON.stringify({
      customerRequest: "Wants a website redesign",
      importantDetails: ["Budget mentioned: 50k INR"],
      currentStatus: "Awaiting quote",
      unansweredQuestions: ["Launch date?"],
      recommendedNextStep: "Send a quotation",
    });
    const result = parseActionResponse("summarize", raw);
    expect(result.displayText).toContain("Customer request: Wants a website redesign");
    expect(result.displayText).toContain("Budget mentioned: 50k INR");
    expect(result.displayText).toContain("Recommended next step: Send a quotation");
    expect(result.structured).toBeDefined();
  });

  it("strips a markdown code fence around a structured JSON response", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        customerRequest: "Test",
        importantDetails: [],
        currentStatus: "Test",
        unansweredQuestions: [],
        recommendedNextStep: "Test",
      }) +
      "\n```";
    const result = parseActionResponse("summarize", raw);
    expect(result.displayText).toContain("Customer request: Test");
  });

  it("throws ChatAgentResponseError for invalid JSON on a structured action", () => {
    expect(() => parseActionResponse("summarize", "not json at all")).toThrow(
      ChatAgentResponseError,
    );
  });

  it("throws ChatAgentResponseError when required structured fields are missing", () => {
    expect(() =>
      parseActionResponse("summarize", JSON.stringify({ customerRequest: "x" })),
    ).toThrow(ChatAgentResponseError);
  });

  it("parses a valid extract_lead JSON response into labeled text, using Not provided for absent fields", () => {
    const raw = JSON.stringify({
      customerName: "Not provided",
      phone: "Not provided",
      email: "Not provided",
      company: "Not provided",
      requestedService: "Website redesign",
      budget: "Not provided",
      timeline: "Not provided",
      location: "Not provided",
      meetingRequested: "Yes",
      callbackRequested: "No",
      quotationRequested: "Unclear",
      purchaseIntent: "Unclear",
      importantNotes: "Not provided",
    });
    const result = parseActionResponse("extract_lead", raw);
    expect(result.displayText).toContain("Customer name: Not provided");
    expect(result.displayText).toContain("Requested service: Website redesign");
    expect(result.displayText).toContain("Meeting request: Yes");
  });
});
