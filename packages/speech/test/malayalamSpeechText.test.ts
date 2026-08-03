import { describe, expect, it } from "vitest";
import { numberToMalayalamWords, prepareMalayalamSpeechText } from "../src/malayalamSpeechText.js";

describe("numberToMalayalamWords", () => {
  it("converts the curated currency amounts to their standard compound forms", () => {
    expect(numberToMalayalamWords(15000)).toBe("പതിനയ്യായിരം");
    expect(numberToMalayalamWords(30000)).toBe("മുപ്പതിനായിരം");
    expect(numberToMalayalamWords(25000)).toBe("ഇരുപത്തയ്യായിരം");
    expect(numberToMalayalamWords(60000)).toBe("അറുപതിനായിരം");
  });

  it("converts single digits used in page ranges", () => {
    expect(numberToMalayalamWords(1)).toBe("ഒന്ന്");
    expect(numberToMalayalamWords(5)).toBe("അഞ്ച്");
    expect(numberToMalayalamWords(10)).toBe("പത്ത്");
  });
});

describe("prepareMalayalamSpeechText", () => {
  it("converts ₹15,000 to പതിനയ്യായിരം രൂപ", () => {
    expect(prepareMalayalamSpeechText("വില ₹15,000 ആണ്.")).toContain("പതിനയ്യായിരം രൂപ");
  });

  it("converts ₹30,000 to മുപ്പതിനായിരം രൂപ", () => {
    expect(prepareMalayalamSpeechText("വില ₹30,000 ആണ്.")).toContain("മുപ്പതിനായിരം രൂപ");
  });

  it("converts 10 pages to പത്ത് പേജുകൾ", () => {
    expect(prepareMalayalamSpeechText("10 pages വേണം.")).toContain("പത്ത് പേജുകൾ");
  });

  it("converts a page range to ഒന്ന് മുതൽ അഞ്ച് പേജുകൾ വരെ", () => {
    expect(prepareMalayalamSpeechText("1–5 pages മതി.")).toContain("ഒന്ന് മുതൽ അഞ്ച് പേജുകൾ വരെ");
  });

  it("uses the curated Malayalam-script equivalents for business terms", () => {
    const result = prepareMalayalamSpeechText(
      "Dravonix Media provides branding, logo, website development and quotation services.",
    );
    expect(result).toContain("ഡ്രാവോണിക്സ് മീഡിയ");
    expect(result).toContain("ബ്രാൻഡിംഗ്");
    expect(result).toContain("ലോഗോ");
    expect(result).toContain("വെബ്സൈറ്റ് ഡെവലപ്മെന്റ്");
    expect(result).toContain("ക്വട്ടേഷൻ");
  });

  it("pronounces Dravonix using ഡ്രാവോണിക്സ് even without the Media suffix", () => {
    expect(prepareMalayalamSpeechText("Dravonix helped us a lot.")).toContain("ഡ്രാവോണിക്സ്");
  });

  it("rewrites a numbered package list with prices into short spoken sentences", () => {
    const display =
      "1. Logo + Brand Guidelines + Business Card Design — ₹15,000\n" +
      "2. Full Brand Identity Package — ₹30,000";

    const result = prepareMalayalamSpeechText(display);

    expect(result).toBe(
      "ഒന്നാമത്തെ പാക്കേജിൽ ലോഗോ, ബ്രാൻഡ് ഗൈഡ്‌ലൈൻസ്, ബിസിനസ് കാർഡ് ഡിസൈൻ എന്നിവ ഉൾപ്പെടും. " +
        "ഇതിന്റെ വില പതിനയ്യായിരം രൂപയാണ്. " +
        "രണ്ടാമത്തേത് ഫുൾ ബ്രാൻഡ് ഐഡന്റിറ്റി പാക്കേജ് ആണ്. " +
        "ഇതിന്റെ വില മുപ്പതിനായിരം രൂപയാണ്.",
    );
  });

  it("removes emojis and Markdown formatting instead of reading them aloud", () => {
    const result = prepareMalayalamSpeechText("## ഓഫർ\n🎉 **വില** _വളരെ_ കുറവാണ്!");
    expect(result).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(result).not.toContain("*");
    expect(result).not.toContain("_");
    expect(result).not.toContain("#");
  });

  it("removes brackets and slashes that should not be spoken", () => {
    const result = prepareMalayalamSpeechText("വില (പ്രത്യേക ഓഫർ) 50/50 ആണ്");
    expect(result).not.toMatch(/[()[\]/]/);
  });

  it("collapses repeated punctuation", () => {
    const result = prepareMalayalamSpeechText("വളരെ നല്ലത്!!! ശരിയാണോ???");
    expect(result).not.toMatch(/([!?])\1/);
  });

  it("normalizes to NFC and collapses whitespace", () => {
    const decomposed = "മ" + "െ" + "ാ";
    const result = prepareMalayalamSpeechText(`  ${decomposed}   ണ്ട്  `);
    expect(result).toBe(result.normalize("NFC"));
    expect(result).not.toMatch(/\s{2,}/);
  });

  it("never mutates the caller's original display text", () => {
    const original = "വില ₹15,000 ആണ്.";
    prepareMalayalamSpeechText(original);
    expect(original).toBe("വില ₹15,000 ആണ്.");
  });
});
