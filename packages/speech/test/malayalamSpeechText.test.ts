import { describe, expect, it } from "vitest";
import {
  isDominantlyMalayalam,
  numberToMalayalamWords,
  prepareMalayalamSpeechText,
} from "../src/malayalamSpeechText.js";

describe("isDominantlyMalayalam", () => {
  it("is true for pure Malayalam text", () => {
    expect(isDominantlyMalayalam("നന്ദി, ഞങ്ങൾ സഹായിക്കാം.")).toBe(true);
  });

  it("is true for Malayalam-English mixed text where Malayalam dominates", () => {
    expect(
      isDominantlyMalayalam(
        "നിങ്ങളുടെ requirement ഒന്ന് പറഞ്ഞാൽ മതി, ഞങ്ങൾ website, branding എന്നിവ ചെയ്യുന്നു.",
      ),
    ).toBe(true);
  });

  it("is false for pure English text", () => {
    expect(isDominantlyMalayalam("Thank you for reaching out to us today.")).toBe(false);
  });

  it("is false for English-dominant mixed text with only a token of Malayalam", () => {
    expect(isDominantlyMalayalam("നന്ദി! We offer website development and AI automation.")).toBe(
      false,
    );
  });
});

describe("numberToMalayalamWords", () => {
  it("converts 30000 to the standard compound form", () => {
    expect(numberToMalayalamWords(30000)).toBe("മുപ്പതിനായിരം");
  });

  it("converts single digits, teens, and simple tens", () => {
    expect(numberToMalayalamWords(5)).toBe("അഞ്ച്");
    expect(numberToMalayalamWords(10)).toBe("പത്ത്");
    expect(numberToMalayalamWords(15)).toBe("പതിനഞ്ച്");
    expect(numberToMalayalamWords(1)).toBe("ഒന്ന്");
  });

  it("converts other round ten-thousands", () => {
    expect(numberToMalayalamWords(10000)).toBe("പതിനായിരം");
    expect(numberToMalayalamWords(50000)).toBe("അമ്പതിനായിരം");
  });
});

describe("prepareMalayalamSpeechText", () => {
  it("converts a currency amount into spoken Malayalam words (₹30,000 -> മുപ്പതിനായിരം രൂപ)", () => {
    expect(prepareMalayalamSpeechText("വില ₹30,000 ആണ്.")).toContain("മുപ്പതിനായിരം രൂപ");
  });

  it("keeps an English unit word after converting the number (10 pages -> പത്ത് pages)", () => {
    expect(prepareMalayalamSpeechText("10 pages വേണം.")).toContain("പത്ത് pages");
  });

  it("converts a range into a natural spoken construction (1-5 pages -> ഒന്ന് മുതൽ അഞ്ച് pages വരെ)", () => {
    expect(prepareMalayalamSpeechText("1-5 pages മതി.")).toContain("ഒന്ന് മുതൽ അഞ്ച് pages വരെ");
  });

  it("preserves common English business words unchanged", () => {
    const result = prepareMalayalamSpeechText(
      "ഞങ്ങൾ website, branding, logo, package എന്നിവ ചെയ്യുന്നു.",
    );
    for (const term of ["website", "branding", "logo", "package"]) {
      expect(result).toContain(term);
    }
  });

  it("shortens a Markdown-formatted list into short spoken sentences, one per item", () => {
    const result = prepareMalayalamSpeechText(
      "ഞങ്ങളുടെ സേവനങ്ങൾ:\n1. Website Design\n2. Branding\n3. Social Media",
    );
    expect(result).toBe("ഞങ്ങളുടെ സേവനങ്ങൾ. Website Design. Branding. Social Media");
  });

  it("strips bold/italic Markdown formatting without reading the symbols aloud", () => {
    const result = prepareMalayalamSpeechText("**വില** _വളരെ_ കുറവാണ്");
    expect(result).toBe("വില വളരെ കുറവാണ്");
    expect(result).not.toContain("*");
    expect(result).not.toContain("_");
  });

  it("strips bullet characters and heading markers", () => {
    const result = prepareMalayalamSpeechText("## തലക്കെട്ട്\n• ഒരു കാര്യം\n• മറ്റൊരു കാര്യം");
    expect(result).not.toMatch(/[#•]/);
  });

  it("normalizes to NFC and collapses whitespace", () => {
    const decomposed = "മ" + "െ" + "ാ"; // a combining vowel sign sequence
    const result = prepareMalayalamSpeechText(`  ${decomposed}   ണ്ട്  `);
    expect(result).toBe(result.normalize("NFC"));
    expect(result).not.toMatch(/\s{2,}/);
  });

  it("never mutates the caller's original display text", () => {
    const original = "വില ₹30,000 ആണ്.";
    prepareMalayalamSpeechText(original);
    expect(original).toBe("വില ₹30,000 ആണ്.");
  });
});
