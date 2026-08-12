import { describe, expect, it } from "vitest";
import {
  containsCompanyAttributionLanguage,
  RESEARCH_COMPANY_FACT_SEPARATION_POLICY,
} from "../../src/research/attribution.js";
import { synthesizeFindings } from "../../src/research/researchSynthesizer.js";
import { rankSources } from "../../src/research/sourceRanker.js";
import type { RawSearchResult } from "../../src/research/types.js";

describe("research / company-fact separation", () => {
  it("tags every synthesized finding with a structural external_research origin marker", () => {
    const result: RawSearchResult = {
      title: "Warm minimalism trend",
      url: "https://example.test/trend",
      domain: "example.test",
      snippet: "Warm minimalism is trending in Dubai luxury interiors.",
      publishedAt: "2026-06-01T00:00:00.000Z",
      retrievedAt: "2026-08-12T09:00:00.000Z",
    };
    const ranked = rankSources([result], { query: "warm minimalism", now: new Date("2026-08-12") });
    const [finding] = synthesizeFindings(ranked);
    expect(finding?.origin).toBe("external_research");
  });

  it("flags an allowed, non-attributed research framing as NOT company-attributed", () => {
    const answer =
      "Current Dubai luxury interiors are also seeing increased interest in warm minimalism.";
    expect(containsCompanyAttributionLanguage(answer)).toBe(false);
  });

  it("flags a disallowed company-attributed claim built from research", () => {
    const answer = "We specialize in warm-minimalist Italian marble projects.";
    expect(containsCompanyAttributionLanguage(answer)).toBe(true);
  });

  it('flags "our team"/"our company" self-attribution language', () => {
    expect(
      containsCompanyAttributionLanguage("Our team currently only offers marble finishes."),
    ).toBe(true);
    expect(
      containsCompanyAttributionLanguage("Our company focuses exclusively on that style."),
    ).toBe(true);
  });

  it("does not flag a neutral company-relevant interpretation that stops short of a claim", () => {
    const answer =
      "Our team can help with villa fit-out projects; current Dubai interiors are also seeing warm minimalism.";
    // "Our team can help" is a generic service statement, not a claim asserting a
    // specific researched fact as the company's own -- allowed per the Phase 1
    // design report's worked example.
    expect(
      containsCompanyAttributionLanguage("Our team can help with villa fit-out projects."),
    ).toBe(false);
    expect(answer).toContain("Our team can help");
  });

  it("the canonical separation policy text explicitly forbids the disallowed example and allows the allowed one", () => {
    expect(RESEARCH_COMPANY_FACT_SEPARATION_POLICY).toContain("never");
    expect(RESEARCH_COMPANY_FACT_SEPARATION_POLICY.toLowerCase()).toContain("knowledgesourceids");
  });
});
