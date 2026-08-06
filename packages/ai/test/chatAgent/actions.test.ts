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

  it("translate embeds the draft text and instructs preserving names/prices/currencies/dates/times/phone numbers/links", () => {
    const instruction = buildActionInstruction(
      baseInput({
        action: "translate",
        staffDraft: "Call us at +911234567890",
        targetLanguage: "hi",
      }),
    );
    expect(instruction).toContain("Call us at +911234567890");
    expect(instruction).toMatch(/Hindi/);
    expect(instruction).toMatch(
      /preserve names, prices, currencies, dates, times, phone numbers, urls/i,
    );
    expect(instruction).toMatch(/product names, and brand names/i);
    expect(instruction).toMatch(/preserve emojis where they appear/i);
    expect(instruction).toMatch(/original paragraph structure/i);
    expect(instruction).toMatch(/preserving its exact original meaning/i);
  });

  it("translate also instructs preserving email addresses and company names", () => {
    const instruction = buildActionInstruction(
      baseInput({
        action: "translate",
        staffDraft: "Email us at sales@example.com",
        targetLanguage: "hi",
      }),
    );
    expect(instruction).toMatch(/urls, email addresses, company names/i);
  });

  it("translate forbids adding any promise, price, date, or confirmation not already in the source text", () => {
    const instruction = buildActionInstruction(
      baseInput({
        action: "translate",
        staffDraft: "We will check and get back to you",
        targetLanguage: "en",
      }),
    );
    expect(instruction).toMatch(
      /do not add any promise, price, date, meeting confirmation, callback confirmation/i,
    );
  });

  it("translate into Malayalam adds fluency/naturalness guidance not present for other target languages", () => {
    const malayalamInstruction = buildActionInstruction(
      baseInput({
        action: "translate",
        staffDraft: "Thanks for your interest",
        targetLanguage: "ml",
      }),
    );
    expect(malayalamInstruction).toMatch(/natural, fluent Malayalam/i);
    expect(malayalamInstruction).toMatch(/never a stiff, word-for-word translation/i);
    expect(malayalamInstruction).toMatch(
      /without transliterating them unnecessarily|instead of transliterating/i,
    );
    expect(malayalamInstruction).toMatch(/preserve that mixed style/i);

    const englishInstruction = buildActionInstruction(
      baseInput({
        action: "translate",
        staffDraft: "Thanks for your interest",
        targetLanguage: "en",
      }),
    );
    expect(englishInstruction).not.toMatch(/Malayalam/i);
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
    expect(result.displayText).toContain("Important details:");
    expect(result.displayText).toContain("Budget mentioned: 50k INR");
    expect(result.displayText).toContain("Current status: Awaiting quote");
    expect(result.displayText).toContain("Questions still unanswered:");
    expect(result.displayText).toContain("Launch date?");
    expect(result.displayText).toContain("Recommended next step: Send a quotation");
    expect(result.structured).toBeDefined();
    // The labeled, staff-readable text passed on to translate as its source
    // -- never the raw JSON the model returned.
    expect(result.displayText).not.toMatch(/[{}]/);
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

  it("classifies an empty response as the empty_response stage, carrying only a character count", () => {
    try {
      parseActionResponse("extract_lead", "   ");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ChatAgentResponseError);
      const responseError = error as ChatAgentResponseError;
      expect(responseError.stage).toBe("empty_response");
      expect(typeof responseError.responseCharacterCount).toBe("number");
      expect(responseError.validationIssueCount).toBeNull();
    }
  });

  it("classifies text with no locatable JSON region as the json_extraction stage", () => {
    try {
      parseActionResponse("extract_lead", "Sure, here is some prose with no braces at all.");
      expect.unreachable();
    } catch (error) {
      expect((error as ChatAgentResponseError).stage).toBe("json_extraction");
    }
  });

  it("classifies a located-but-malformed JSON region as the json_parse stage, distinct from json_extraction", () => {
    try {
      parseActionResponse("extract_lead", '```json\n{"customerName": ,}\n```');
      expect.unreachable();
    } catch (error) {
      expect((error as ChatAgentResponseError).stage).toBe("json_parse");
    }
  });

  it("classifies valid JSON that fails schema validation as schema_validation, carrying an issue count", () => {
    try {
      parseActionResponse("summarize", JSON.stringify({ customerRequest: "x" }));
      expect.unreachable();
    } catch (error) {
      const responseError = error as ChatAgentResponseError;
      expect(responseError.stage).toBe("schema_validation");
      expect(responseError.validationIssueCount).toBeGreaterThan(0);
    }
  });

  it("parses fenced structured JSON for extract_lead the same way as summarize", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
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
      }) +
      "\n```";
    const result = parseActionResponse("extract_lead", raw);
    expect(result.displayText).toContain("Requested service: Website redesign");
  });

  it("parses structured JSON with leading/trailing explanatory text around it", () => {
    const raw =
      "Here is the summary you asked for:\n" +
      JSON.stringify({
        customerRequest: "Wants pricing",
        importantDetails: [],
        currentStatus: "Open",
        unansweredQuestions: [],
        recommendedNextStep: "Follow up",
      }) +
      "\nLet me know if you need anything else.";
    const result = parseActionResponse("summarize", raw);
    expect(result.displayText).toContain("Customer request: Wants pricing");
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

  it("carries phone, email, and price/date values into the labeled displayText completely unchanged (never re-formatted or altered)", () => {
    const raw = JSON.stringify({
      customerName: "Priya Menon",
      phone: "+91 98765 43210",
      email: "priya.menon@example.com",
      company: "Acme Traders Pvt Ltd",
      requestedService: "Website redesign",
      budget: "INR 50,000",
      timeline: "By 15 March 2026",
      location: "Kochi",
      meetingRequested: "Yes",
      callbackRequested: "No",
      quotationRequested: "Yes",
      purchaseIntent: "High",
      importantNotes: "Prefers WhatsApp over email for updates.",
    });
    const result = parseActionResponse("extract_lead", raw);
    expect(result.displayText).toContain("Phone: +91 98765 43210");
    expect(result.displayText).toContain("Email: priya.menon@example.com");
    expect(result.displayText).toContain("Budget: INR 50,000");
    expect(result.displayText).toContain("Timeline: By 15 March 2026");
    expect(result.displayText).toContain("Customer name: Priya Menon");
    expect(result.displayText).toContain("Company: Acme Traders Pvt Ltd");
    // This is the labeled, staff-readable text passed on to translate as its
    // source -- never the raw JSON the model returned.
    expect(result.displayText).not.toMatch(/[{}]/);
  });
});
