import { describe, expect, it } from "vitest";
import { sanitizeKeyterms } from "../src/keytermSanitizer.js";

describe("sanitizeKeyterms", () => {
  it("accepts a normal short term", () => {
    const { keyterms, summary } = sanitizeKeyterms(["Dravonix"]);
    expect(keyterms).toEqual(["Dravonix"]);
    expect(summary).toEqual({
      inputCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      rejectionReasons: { invalidType: 0, empty: 0, tooLong: 0, tooManyWords: 0, duplicate: 0 },
    });
  });

  it("accepts a 49-character term", () => {
    const term = "a".repeat(49);
    const { keyterms } = sanitizeKeyterms([term]);
    expect(keyterms).toEqual([term]);
  });

  it("rejects a 50-character term", () => {
    const term = "a".repeat(50);
    const { keyterms, summary } = sanitizeKeyterms([term]);
    expect(keyterms).toEqual([]);
    expect(summary.rejectionReasons.tooLong).toBe(1);
  });

  it("rejects a term longer than 50 characters", () => {
    const term = "a".repeat(75);
    const { keyterms, summary } = sanitizeKeyterms([term]);
    expect(keyterms).toEqual([]);
    expect(summary.rejectionReasons.tooLong).toBe(1);
  });

  it("accepts a term with exactly 5 words when otherwise valid", () => {
    const term = "alpha beta gamma delta epsilon";
    const { keyterms } = sanitizeKeyterms([term]);
    expect(keyterms).toEqual([term]);
  });

  it("rejects a term with more than 5 words", () => {
    const term = "alpha beta gamma delta epsilon zeta";
    const { keyterms, summary } = sanitizeKeyterms([term]);
    expect(keyterms).toEqual([]);
    expect(summary.rejectionReasons.tooManyWords).toBe(1);
  });

  it("removes empty and whitespace-only terms", () => {
    const { keyterms, summary } = sanitizeKeyterms(["", "   ", "\t\n"]);
    expect(keyterms).toEqual([]);
    expect(summary.rejectionReasons.empty).toBe(3);
  });

  it("removes duplicate terms case-insensitively while preserving first occurrence and original order", () => {
    const { keyterms, summary } = sanitizeKeyterms(["Zoho", "CRM", "zoho", "ZOHO", "SaaS"]);
    expect(keyterms).toEqual(["Zoho", "CRM", "SaaS"]);
    expect(summary.rejectionReasons.duplicate).toBe(2);
  });

  it("strips unsupported characters rather than rejecting the whole term", () => {
    const { keyterms } = sanitizeKeyterms(["CRM[beta]", "<Zoho>", "SaaS\\Cloud"]);
    expect(keyterms).toEqual(["CRMbeta", "Zoho", "SaaSCloud"]);
  });

  it("rejects a term that becomes empty once unsupported characters are stripped", () => {
    const { keyterms, summary } = sanitizeKeyterms(["<>{}[]\\"]);
    expect(keyterms).toEqual([]);
    expect(summary.rejectionReasons.empty).toBe(1);
  });

  it("collapses internal whitespace runs left after stripping unsupported characters", () => {
    const { keyterms } = sanitizeKeyterms(["Zoho[  ]CRM"]);
    // "[  ]" strips to two spaces between "Zoho" and "CRM", which must
    // collapse to one -- otherwise this would be miscounted as extra words.
    expect(keyterms).toEqual(["Zoho CRM"]);
  });

  it("counts Malayalam text correctly and accepts a short Malayalam term", () => {
    const term = "കേരളം"; // "Kerala" in Malayalam, well under 50 characters/5 words
    const { keyterms } = sanitizeKeyterms([term]);
    expect(keyterms).toEqual([term]);
  });

  it("counts Unicode code points, not UTF-16 code units, so astral-plane characters aren't double-counted", () => {
    // 40 code points, but 80 UTF-16 code units (each is a surrogate pair) --
    // a naive `.length` check would wrongly reject this as >= 50.
    const term = "\u{1F600}".repeat(40);
    expect(term.length).toBe(80);
    const { keyterms, summary } = sanitizeKeyterms([term]);
    expect(keyterms).toEqual([term]);
    expect(summary.rejectionReasons.tooLong).toBe(0);
  });

  it("keeps the valid terms in a list containing one invalid and several valid terms", () => {
    const { keyterms, summary } = sanitizeKeyterms([
      "Dravonix",
      "a".repeat(60),
      "branding",
      "Kerala",
    ]);
    expect(keyterms).toEqual(["Dravonix", "branding", "Kerala"]);
    expect(summary).toEqual({
      inputCount: 4,
      acceptedCount: 3,
      rejectedCount: 1,
      rejectionReasons: { invalidType: 0, empty: 0, tooLong: 1, tooManyWords: 0, duplicate: 0 },
    });
  });

  it("returns an empty result when every term is invalid", () => {
    const { keyterms, summary } = sanitizeKeyterms(["a".repeat(60), "", "one two three four five six"]);
    expect(keyterms).toEqual([]);
    expect(summary.acceptedCount).toBe(0);
    expect(summary.rejectedCount).toBe(3);
  });

  it("never throws and returns empty for non-string entries or non-array input", () => {
    expect(sanitizeKeyterms(undefined).keyterms).toEqual([]);
    expect(sanitizeKeyterms(null).keyterms).toEqual([]);
    expect(sanitizeKeyterms("not an array").keyterms).toEqual([]);
    expect(sanitizeKeyterms(42).keyterms).toEqual([]);

    const { keyterms, summary } = sanitizeKeyterms(["Dravonix", 42, null, { bad: true }, "Kerala"]);
    expect(keyterms).toEqual(["Dravonix", "Kerala"]);
    expect(summary.rejectionReasons.invalidType).toBe(3);
  });

  it("never truncates an overlong term -- it is dropped, not shortened", () => {
    const term = "a".repeat(120);
    const { keyterms } = sanitizeKeyterms([term]);
    expect(keyterms).toEqual([]);
    expect(keyterms.some((k) => term.startsWith(k))).toBe(false);
  });
});
