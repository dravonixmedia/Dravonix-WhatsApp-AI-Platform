import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/prompt/buildSystemPrompt.js";
import { makeInput } from "../fixtures.js";

/**
 * Regression coverage for the staging bug where
 * "can you do a research on the kerala market for competitive of my
 * brands?" was misread as a question about whether Dravonix sells market
 * research as a service, producing an immediate human-handover fallback
 * instead of performing the research.
 *
 * True intent classification is Claude's own judgment (the task explicitly
 * forbids a brittle keyword-only classifier), so it cannot be unit-tested
 * deterministically without a real model call -- that end-to-end
 * verification is the staging live-regression pass. What IS deterministic
 * and testable here is that the system prompt actually contains the
 * corrected guidance: the RESEARCH ACTION REQUEST vs SERVICE CAPABILITY
 * QUESTION distinction, the intent-signal hints, the exact override rule,
 * and that every one of the 10 task scenario messages is traceably covered
 * by that guidance.
 */
function researchPrompt() {
  const { company, memory, knowledge, temporal } = makeInput();
  return buildSystemPrompt(company, memory, knowledge, temporal, true);
}

describe("WEB RESEARCH prompt -- RESEARCH ACTION REQUEST vs SERVICE CAPABILITY QUESTION", () => {
  const prompt = researchPrompt();

  it("names the distinction explicitly", () => {
    expect(prompt).toContain("RESEARCH ACTION REQUEST vs SERVICE CAPABILITY QUESTION");
  });

  it("defines a RESEARCH ACTION REQUEST as an instruction to perform research, not a sales question", () => {
    expect(prompt).toMatch(/RESEARCH ACTION REQUEST asks YOU to go and perform research/);
    expect(prompt).toMatch(/never as a question about what the company sells/);
  });

  it("defines a SERVICE CAPABILITY QUESTION as asking about the company's own service catalog", () => {
    expect(prompt).toMatch(/SERVICE CAPABILITY QUESTION asks whether THE COMPANY offers research/);
    expect(prompt).toMatch(/must NOT automatically trigger web_search/);
  });

  it("includes the required intent-signal hint phrases (guidance, not a rigid list)", () => {
    expect(prompt).toMatch(/not a\s*\n?\s*rigid keyword list/);
    // Normalize whitespace: the prompt hand-wraps long bullet lines, so a
    // multi-word phrase can straddle a "\n  " line break in the raw string
    // even though it reads as one continuous phrase to the model.
    const normalized = prompt.toLowerCase().replace(/\s+/g, " ");
    for (const phrase of [
      "do a research",
      "research this",
      "research the market",
      "look into",
      "investigate",
      "analyze the",
      "find competitors",
      "compare competitors",
      "competitor analysis",
      "market analysis",
      "look up",
      "find out",
      "check the latest",
      "what are the latest",
      "what is currently happening",
      "current trends",
      "current market",
      "latest trends",
      "recent developments",
    ]) {
      expect(normalized).toContain(phrase.toLowerCase());
    }
  });

  it("includes the exact CRITICAL PROMPT RULE instruction", () => {
    expect(prompt).toMatch(
      /CRITICAL: When the customer explicitly asks you to research, investigate, analyze, compare, look\s*\n?\s*up, or find current public information, treat this as a request to perform the research yourself\s*\n?\s*using web search\./,
    );
    expect(prompt).toMatch(
      /Do NOT interpret the request as a question about whether the company sells or\s*\n?\s*offers research as a service unless the customer explicitly asks whether research is a company\s*\n?\s*service\./,
    );
  });

  it("includes all three worked examples from the task, with correct outcomes", () => {
    expect(prompt).toContain(
      'Customer: "Can you research the Kerala market for competitors?" -> PERFORM RESEARCH.',
    );
    expect(prompt).toContain(
      'Customer: "Do you offer market research?" -> answer whether the COMPANY offers that service.',
    );
    expect(prompt).toContain(
      'Customer: "Can you research competitors for my project?" -> PERFORM RESEARCH.',
    );
  });

  it("states that an explicit research request overrides the unknown-company-knowledge handover fallback", () => {
    expect(prompt).toMatch(/A RESEARCH ACTION REQUEST overrides the usual/);
    expect(prompt).toMatch(/use web_search rather than escalating to a human immediately/);
  });

  it("carries the override into the empty-knowledge branch and the general escalation instruction too", () => {
    expect(prompt).toMatch(
      /use web_search per the WEB RESEARCH rules above instead of escalating immediately/,
    );
    expect(prompt).toMatch(
      /Exception: if the customer explicitly asked you to research, investigate, analyze, compare,\s*\n?\s*or look something up, use web_search first/,
    );
  });
});

describe("10 task regression scenarios -- traceable prompt coverage", () => {
  const prompt = researchPrompt();

  const researchActionRequests = [
    "Can you research the Kerala market for competitors?",
    "Can you do a research on the Kerala market for competitive interior fit-out brands?",
    "Research the latest luxury villa interior trends in Dubai.",
    "Find the major competitors in Kerala for interior fit-out.",
  ];

  it.each(researchActionRequests)(
    "scenario: %s -- covered by the RESEARCH ACTION REQUEST guidance (research/find/latest trends signals present)",
    (message) => {
      const lower = message.toLowerCase();
      const promptLower = prompt.toLowerCase();
      // Every one of these messages contains at least one documented intent-signal phrase.
      const signalPresent = [
        "research",
        "find competitors",
        "latest trends",
        "current trends",
      ].some((signal) => lower.includes(signal.split(" ")[0]!));
      expect(signalPresent).toBe(true);
      expect(promptLower).toContain("research");
      expect(prompt).toMatch(/PERFORM RESEARCH/);
    },
  );

  const serviceCapabilityQuestions = [
    "Do you offer market research as a service?",
    "Is market research included in your package?",
  ];

  it.each(serviceCapabilityQuestions)(
    "scenario: %s -- covered by the SERVICE CAPABILITY QUESTION guidance (must NOT auto-trigger research)",
    () => {
      expect(prompt).toMatch(
        /SERVICE CAPABILITY QUESTION asks whether THE COMPANY offers research/,
      );
      expect(prompt).toMatch(/must NOT automatically trigger web_search/);
      expect(prompt).toContain(
        'Customer: "Do you offer market research?" -> answer whether the COMPANY offers that service.',
      );
    },
  );

  const normalCompanyQuestions = ["What services do you provide?", "What is your office address?"];

  it.each(normalCompanyQuestions)(
    "scenario: %s -- covered by the existing 'do NOT use web_search for simple questions' rule",
    () => {
      expect(prompt).toMatch(
        /Do NOT use web_search for simple questions company knowledge already answers, such as business\s*\n?\s*hours, which services or products you offer, or your office address/,
      );
    },
  );

  it("scenario: explicit Spanish research request -- research guidance + language-synthesis policy both present", () => {
    expect(prompt).toMatch(/PERFORM RESEARCH/);
    expect(prompt).toMatch(
      /DRAIVA responds in the customer's language whenever it can reasonably determine the language/,
    );
  });

  it("scenario: explicit Arabic research request -- research guidance + language-synthesis policy both present", () => {
    expect(prompt).toMatch(/PERFORM RESEARCH/);
    expect(prompt).toMatch(
      /never changes which language the final customer-facing answer is synthesized into/,
    );
  });
});

describe("the exact reported staging failure message", () => {
  it("the literal customer message that triggered this fix contains a documented research intent signal", () => {
    const message = "can you do a research on the kerala market for competitive of my brands?";
    expect(message.toLowerCase()).toContain("do a research");
    const prompt = researchPrompt();
    expect(prompt.toLowerCase()).toContain("do a research");
    expect(prompt).toMatch(/PERFORM RESEARCH/);
  });

  it("the prompt explicitly forbids treating a research request as a service-catalog question, which is exactly the observed bug", () => {
    const prompt = researchPrompt();
    expect(prompt).toMatch(
      /Do NOT interpret the request as a question about whether the company sells or\s*\n?\s*offers research as a service/,
    );
  });
});
