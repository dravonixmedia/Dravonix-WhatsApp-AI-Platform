import { describe, expect, it } from "vitest";
import { detectLikelySourceLanguage } from "../../src/chatAgent/languageDetection.js";

describe("detectLikelySourceLanguage", () => {
  it("detects English text", () => {
    expect(
      detectLikelySourceLanguage("Thank you for reaching out, we will get back to you soon."),
    ).toBe("en");
  });

  it("detects Malayalam text", () => {
    expect(detectLikelySourceLanguage("നന്ദി, ഞങ്ങൾ ഉടൻ തിരികെ ബന്ധപ്പെടും.")).toBe("ml");
  });

  it("detects Hindi text", () => {
    expect(detectLikelySourceLanguage("धन्यवाद, हम जल्द ही आपसे संपर्क करेंगे।")).toBe("hi");
  });

  it("detects Arabic text", () => {
    expect(detectLikelySourceLanguage("شكرا لك، سنتواصل معك قريبا.")).toBe("ar");
  });

  it("returns null for empty or whitespace-only text -- never blocks on no signal", () => {
    expect(detectLikelySourceLanguage("")).toBeNull();
    expect(detectLikelySourceLanguage("   ")).toBeNull();
  });

  it("returns null for text with no script signal at all (e.g. only numbers/punctuation)", () => {
    expect(detectLikelySourceLanguage("12345 !!! ---")).toBeNull();
  });

  it("picks the dominant script for mixed Malayalam-English text", () => {
    // Mostly Malayalam with one embedded English brand name.
    expect(detectLikelySourceLanguage("നന്ദി, ഞങ്ങളുടെ ProductX വളരെ നല്ലതാണ്")).toBe("ml");
  });

  it("falls back to English when Latin characters dominate a mostly-English message with a foreign name", () => {
    expect(detectLikelySourceLanguage("Hi Rahul, your order will arrive tomorrow.")).toBe("en");
  });
});
