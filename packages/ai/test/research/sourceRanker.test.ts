import { describe, expect, it } from "vitest";
import {
  classifyAuthorityTier,
  rankSources,
  scoreFreshness,
  scoreRelevance,
} from "../../src/research/sourceRanker.js";
import type { RawSearchResult } from "../../src/research/types.js";

const NOW = new Date("2026-08-12T09:00:00.000Z");

function makeResult(overrides: Partial<RawSearchResult> = {}): RawSearchResult {
  return {
    title: "Interior design trends",
    url: "https://example.test/article",
    domain: "example.test",
    snippet: "A discussion of interior design trends in villas.",
    publishedAt: "2026-07-01T00:00:00.000Z",
    retrievedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("classifyAuthorityTier", () => {
  it("classifies a .gov domain as official_government", () => {
    expect(classifyAuthorityTier("dubai-municipality.gov.ae")).toBe("official_government");
  });

  it("classifies a non-forum .org domain as recognized_professional_organization", () => {
    expect(classifyAuthorityTier("interior-designers-institute.org")).toBe(
      "recognized_professional_organization",
    );
  });

  it("does not classify a forum/wiki .org as a professional organization", () => {
    expect(classifyAuthorityTier("design-forum.org")).not.toBe(
      "recognized_professional_organization",
    );
  });

  it("classifies a publication-shaped domain as established_industry_publication", () => {
    expect(classifyAuthorityTier("interior-design-news.test")).toBe(
      "established_industry_publication",
    );
  });

  it("falls back to general_web for an unrecognized domain, never claiming false authority", () => {
    expect(classifyAuthorityTier("randomblog.test")).toBe("general_web");
  });
});

describe("scoreRelevance", () => {
  it("scores 1 when every meaningful query word appears in the result", () => {
    const score = scoreRelevance("villa interior trends", {
      title: "Villa Interior Trends 2026",
      snippet: "Everything about villa interior trends this year.",
    });
    expect(score).toBe(1);
  });

  it("scores lower when only some query words are present", () => {
    const score = scoreRelevance("villa interior trends Dubai", {
      title: "Villa Interior Trends",
      snippet: "Discussion of villa interiors.",
    });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("scores 0 for a completely unrelated result", () => {
    const score = scoreRelevance("villa interior trends", {
      title: "Recipe for banana bread",
      snippet: "A simple baking recipe.",
    });
    expect(score).toBe(0);
  });
});

describe("scoreFreshness", () => {
  it("scores a result published today at (close to) 1", () => {
    expect(scoreFreshness(NOW.toISOString(), NOW)).toBeCloseTo(1, 5);
  });

  it("scores an older result lower than a newer one", () => {
    const older = scoreFreshness("2020-01-01T00:00:00.000Z", NOW);
    const newer = scoreFreshness("2026-08-01T00:00:00.000Z", NOW);
    expect(newer).toBeGreaterThan(older);
  });

  it("scores a missing publish date as neutral-low, not zero", () => {
    const score = scoreFreshness(null, NOW);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.5);
  });

  it("scores an unparsable date the same as a missing one", () => {
    expect(scoreFreshness("not-a-date", NOW)).toBe(scoreFreshness(null, NOW));
  });
});

describe("rankSources", () => {
  it("is deterministic for the same input", () => {
    const results = [makeResult({ domain: "a.test", url: "https://a.test/1" })];
    const rankedA = rankSources(results, { query: "interior design trends", now: NOW });
    const rankedB = rankSources(results, { query: "interior design trends", now: NOW });
    expect(rankedA).toEqual(rankedB);
  });

  it("never mutates the input array", () => {
    const results = [
      makeResult({ domain: "a.test", url: "https://a.test/1" }),
      makeResult({ domain: "b.test", url: "https://b.test/1" }),
    ];
    const copy = [...results];
    rankSources(results, { query: "interior design trends", now: NOW });
    expect(results).toEqual(copy);
  });

  it("ranks a higher-authority source above an otherwise-similar lower-authority one", () => {
    const govResult = makeResult({ domain: "authority.gov", url: "https://authority.gov/a" });
    const blogResult = makeResult({ domain: "randomblog.test", url: "https://randomblog.test/a" });
    const [first, second] = rankSources([blogResult, govResult], {
      query: "interior design trends",
      now: NOW,
    });
    expect(first?.domain).toBe("authority.gov");
    expect(second?.domain).toBe("randomblog.test");
  });

  it("applies a domain diversity penalty to repeated results from the same domain", () => {
    const first = makeResult({ domain: "same.test", url: "https://same.test/1" });
    const second = makeResult({ domain: "same.test", url: "https://same.test/2" });
    const [ranked1, ranked2] = rankSources([first, second], {
      query: "interior design trends",
      now: NOW,
    });
    expect(ranked1?.domainDiversityPenalty).toBe(0);
    expect(ranked2?.domainDiversityPenalty).toBeGreaterThan(0);
  });

  it("does not penalize distinct domains for diversity", () => {
    const first = makeResult({ domain: "a.test", url: "https://a.test/1" });
    const second = makeResult({ domain: "b.test", url: "https://b.test/1" });
    const ranked = rankSources([first, second], { query: "interior design trends", now: NOW });
    for (const source of ranked) {
      expect(source.domainDiversityPenalty).toBe(0);
    }
  });

  it("keeps every composite score within [0, 1]", () => {
    const results = [
      makeResult({ domain: "authority.gov", url: "https://authority.gov/1" }),
      makeResult({ domain: "same.test", url: "https://same.test/1" }),
      makeResult({ domain: "same.test", url: "https://same.test/2" }),
      makeResult({ domain: "same.test", url: "https://same.test/3", publishedAt: null }),
    ];
    const ranked = rankSources(results, { query: "interior design trends", now: NOW });
    for (const source of ranked) {
      expect(source.compositeScore).toBeGreaterThanOrEqual(0);
      expect(source.compositeScore).toBeLessThanOrEqual(1);
    }
  });
});
