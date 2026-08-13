import { describe, expect, it } from "vitest";
import { detectResearchIntent } from "../../src/research/intentDetector.js";

describe("detectResearchIntent -- MUST return researchRequired=true", () => {
  const mustBeTrue = [
    "Can you research the Kerala market?",
    "Can you do research on our competitors?",
    "Research the latest digital marketing trends.",
    "Find the main competitors in Kerala.",
    "Do a competitor analysis.",
    "Analyze the current market.",
    "Look into the Kerala market.",
    "What are the latest digital marketing trends?",
    "What is happening in the market right now?",
  ];

  it.each(mustBeTrue)("%s -> researchRequired=true", (message) => {
    expect(detectResearchIntent(message).researchRequired).toBe(true);
  });
});

describe("detectResearchIntent -- MUST NOT trigger (researchRequired=false)", () => {
  const mustBeFalse = [
    "Do you offer market research as a service?",
    "Is market research one of your services?",
    "What services do you provide?",
    "What is your office address?",
    "What are your opening hours?",
  ];

  it.each(mustBeFalse)("%s -> researchRequired=false", (message) => {
    expect(detectResearchIntent(message).researchRequired).toBe(false);
  });
});

describe("detectResearchIntent -- required test categories A-K", () => {
  it("A. explicit research request -> researchRequired=true", () => {
    expect(detectResearchIntent("Can you research the Kerala market?").researchRequired).toBe(true);
  });

  it("B. market research request -> researchRequired=true", () => {
    expect(
      detectResearchIntent("Please research the current market for us.").researchRequired,
    ).toBe(true);
  });

  it("C. competitor research request -> researchRequired=true", () => {
    expect(
      detectResearchIntent("Can you do a competitor analysis for our brand?").researchRequired,
    ).toBe(true);
  });

  it("D. current/latest trend request -> researchRequired=true", () => {
    expect(
      detectResearchIntent("What are the latest interior design trends in Dubai?").researchRequired,
    ).toBe(true);
  });

  it('E. "Do you offer market research?" -> researchRequired=false', () => {
    expect(
      detectResearchIntent("Do you offer market research as a service?").researchRequired,
    ).toBe(false);
  });

  it("F. normal company-service question -> researchRequired=false", () => {
    expect(detectResearchIntent("What services do you provide?").researchRequired).toBe(false);
  });

  it("J. Spanish research request -> researchRequired=true", () => {
    expect(detectResearchIntent("¿Puedes investigar el mercado de Kerala?").researchRequired).toBe(
      true,
    );
    expect(
      detectResearchIntent("Investiga las últimas tendencias de marketing digital.")
        .researchRequired,
    ).toBe(true);
  });

  it("K. Arabic research request -> researchRequired=true", () => {
    expect(detectResearchIntent("هل يمكنك أن ابحث عن السوق في كيرالا؟").researchRequired).toBe(
      true,
    );
    expect(detectResearchIntent("حلل المنافسين في السوق الحالي.").researchRequired).toBe(true);
  });
});

describe("detectResearchIntent -- edge cases", () => {
  it("returns false and no matched signal for an empty message", () => {
    expect(detectResearchIntent("")).toEqual({ researchRequired: false, matchedSignal: null });
    expect(detectResearchIntent("   ")).toEqual({
      researchRequired: false,
      matchedSignal: null,
    });
  });

  it("checks the SERVICE CAPABILITY exclusion before any action-verb pattern, even when both words are present", () => {
    // Contains "research" (an action-pattern word) AND the exclusion phrase
    // "do you offer" -- the exclusion must win, since this is exactly the
    // originally-reported staging confusion.
    const result = detectResearchIntent("Do you offer market research as a service?");
    expect(result.researchRequired).toBe(false);
  });

  it("reports which pattern matched, for diagnostics", () => {
    const result = detectResearchIntent("Can you research the Kerala market?");
    expect(result.researchRequired).toBe(true);
    expect(result.matchedSignal).toBeTruthy();
  });
});

describe("detectResearchIntent -- exact regression: the reported staging failure messages", () => {
  it('the original bug report message "can you do a research on the kerala market for competitive of my brands?" -> true', () => {
    expect(
      detectResearchIntent(
        "can you do a research on the kerala market for competitive of my brands?",
      ).researchRequired,
    ).toBe(true);
  });

  it('the follow-up regression test message "Can you research the Kerala market for competing digital marketing agencies?" -> true', () => {
    expect(
      detectResearchIntent(
        "Can you research the Kerala market for competing digital marketing agencies?",
      ).researchRequired,
    ).toBe(true);
  });

  it('the follow-up regression test message "What are the latest digital marketing trends in Kerala?" -> true', () => {
    expect(
      detectResearchIntent("What are the latest digital marketing trends in Kerala?")
        .researchRequired,
    ).toBe(true);
  });

  it('the normal-service-question regression test message "What services do you provide?" -> false', () => {
    expect(detectResearchIntent("What services do you provide?").researchRequired).toBe(false);
  });
});
