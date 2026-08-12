import { describe, expect, it } from "vitest";
import { synthesizeFindings } from "../../src/research/researchSynthesizer.js";
import { rankSources } from "../../src/research/sourceRanker.js";
import type { RawSearchResult } from "../../src/research/types.js";

const NOW = new Date("2026-08-12T09:00:00.000Z");

function makeResult(overrides: Partial<RawSearchResult> = {}): RawSearchResult {
  return {
    title: "Result",
    url: "https://example.test/1",
    domain: "example.test",
    snippet: "A snippet describing this result.",
    publishedAt: "2026-07-01T00:00:00.000Z",
    retrievedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("synthesizeFindings", () => {
  it("tags every finding as external_research", () => {
    const ranked = rankSources([makeResult()], { query: "result", now: NOW });
    const findings = synthesizeFindings(ranked);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.origin).toBe("external_research");
  });

  it("caps the number of findings at maxSources", () => {
    const results = Array.from({ length: 8 }, (_, i) =>
      makeResult({ url: `https://example.test/${i}`, domain: `d${i}.test` }),
    );
    const ranked = rankSources(results, { query: "result", now: NOW });
    const findings = synthesizeFindings(ranked, { maxSources: 3 });
    expect(findings).toHaveLength(3);
  });

  it("defaults to at most 5 findings", () => {
    const results = Array.from({ length: 9 }, (_, i) =>
      makeResult({ url: `https://example.test/${i}`, domain: `d${i}.test` }),
    );
    const ranked = rankSources(results, { query: "result", now: NOW });
    const findings = synthesizeFindings(ranked);
    expect(findings).toHaveLength(5);
  });

  it("truncates an overly long snippet into a bounded keyFindings excerpt", () => {
    const longSnippet = "a".repeat(500);
    const ranked = rankSources([makeResult({ snippet: longSnippet })], {
      query: "result",
      now: NOW,
    });
    const findings = synthesizeFindings(ranked);
    expect(findings[0]?.keyFindings.length).toBeLessThan(longSnippet.length);
    expect(findings[0]?.keyFindings.endsWith("...")).toBe(true);
  });

  it("preserves source provenance fields on each finding", () => {
    const result = makeResult({
      title: "Provenance Title",
      url: "https://example.test/provenance",
      domain: "example.test",
      publishedAt: "2026-05-01T00:00:00.000Z",
    });
    const ranked = rankSources([result], { query: "result", now: NOW });
    const [finding] = synthesizeFindings(ranked);
    expect(finding).toMatchObject({
      sourceUrl: "https://example.test/provenance",
      sourceTitle: "Provenance Title",
      sourceDomain: "example.test",
      publishedAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("returns an empty array for an empty ranked list", () => {
    expect(synthesizeFindings([])).toEqual([]);
  });
});
