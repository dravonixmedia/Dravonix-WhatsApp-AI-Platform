import { describe, expect, it } from "vitest";
import { resolveFallbackMessage } from "../src/fallbackMessage.js";

const DEPRECATED_DEFAULT =
  "Automated assistance is temporarily unavailable. Our team will respond as soon as possible.";

describe("resolveFallbackMessage", () => {
  it("replaces the deprecated time-promise default with the corrected English text", () => {
    const result = resolveFallbackMessage(DEPRECATED_DEFAULT, "en");
    expect(result).not.toContain("respond as soon as possible");
    expect(result).toBe(
      "I couldn't complete that request automatically. I've shared it with the Dravonix Media team for assistance.",
    );
  });

  it("returns the Malayalam equivalent when the detected language is Malayalam", () => {
    const result = resolveFallbackMessage(DEPRECATED_DEFAULT, "ml");
    expect(result).not.toContain("respond as soon as possible");
    expect(result).toMatch(/[ഀ-ൿ]/); // contains Malayalam Unicode script
  });

  it("treats a BCP-47-qualified Malayalam code (ml-IN) the same as ml", () => {
    const result = resolveFallbackMessage(DEPRECATED_DEFAULT, "ml-IN");
    expect(result).toMatch(/[ഀ-ൿ]/);
  });

  it("defaults to English when the language is null or unknown", () => {
    expect(resolveFallbackMessage(DEPRECATED_DEFAULT, null)).toContain("Dravonix Media team");
    expect(resolveFallbackMessage(DEPRECATED_DEFAULT, "fr")).toContain("Dravonix Media team");
  });

  it("leaves a genuinely customized fallback message untouched, in any language", () => {
    const custom = "Please hold on, our support desk will pick this up shortly.";
    expect(resolveFallbackMessage(custom, "en")).toBe(custom);
    expect(resolveFallbackMessage(custom, "ml")).toBe(custom);
  });
});
