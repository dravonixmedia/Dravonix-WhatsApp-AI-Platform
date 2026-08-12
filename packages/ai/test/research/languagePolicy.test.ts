import { describe, expect, it } from "vitest";
import { DRAIVA_LANGUAGE_POLICY } from "../../src/prompt/languagePolicy.js";
import { RESEARCH_LANGUAGE_SYNTHESIS_POLICY } from "../../src/research/languagePolicy.js";

describe("RESEARCH_LANGUAGE_SYNTHESIS_POLICY (multilingual synthesis metadata)", () => {
  it("reuses the canonical DRAIVA_LANGUAGE_POLICY sentence verbatim, never restating it", () => {
    expect(RESEARCH_LANGUAGE_SYNTHESIS_POLICY).toContain(DRAIVA_LANGUAGE_POLICY);
  });

  it("states that research findings may be in English without requiring the final answer to be", () => {
    expect(RESEARCH_LANGUAGE_SYNTHESIS_POLICY).toMatch(/English/);
    expect(RESEARCH_LANGUAGE_SYNTHESIS_POLICY).toMatch(/never changes which language/i);
  });

  it("explicitly forbids introducing a language whitelist", () => {
    expect(RESEARCH_LANGUAGE_SYNTHESIS_POLICY.toLowerCase()).toContain(
      "never introduce a language whitelist",
    );
  });

  it("does not name a fixed, closed set of supported languages", () => {
    // The regression this guards: reintroducing an "English or Malayalam
    // only" style restriction. Only "English" appears (as an example of what
    // a source might be in) -- no other language name should be hard-coded
    // as a restriction here.
    const languageNames = ["Malayalam", "Spanish", "Arabic", "Hindi", "French"];
    for (const name of languageNames) {
      expect(RESEARCH_LANGUAGE_SYNTHESIS_POLICY).not.toContain(name);
    }
  });
});
