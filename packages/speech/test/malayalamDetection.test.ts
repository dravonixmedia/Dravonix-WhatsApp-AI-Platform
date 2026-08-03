import { describe, expect, it } from "vitest";
import { isDominantlyMalayalam, isMalayalamLanguageCode } from "../src/malayalamDetection.js";

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

describe("isMalayalamLanguageCode", () => {
  it("is true for ml and ml-IN", () => {
    expect(isMalayalamLanguageCode("ml")).toBe(true);
    expect(isMalayalamLanguageCode("ml-IN")).toBe(true);
    expect(isMalayalamLanguageCode("ML")).toBe(true);
  });

  it("is false for other language codes, null, and undefined", () => {
    expect(isMalayalamLanguageCode("en")).toBe(false);
    expect(isMalayalamLanguageCode("en-US")).toBe(false);
    expect(isMalayalamLanguageCode(null)).toBe(false);
    expect(isMalayalamLanguageCode(undefined)).toBe(false);
  });
});
