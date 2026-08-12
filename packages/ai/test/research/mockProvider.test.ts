import { describe, expect, it } from "vitest";
import { MockWebResearchProvider } from "../../src/research/mockProvider.js";
import type { RawSearchResult } from "../../src/research/types.js";

describe("MockWebResearchProvider", () => {
  it("never performs a real network call and returns a deterministic default response", async () => {
    const provider = new MockWebResearchProvider();
    const resultsA = await provider.search("luxury villa interior trends Dubai");
    const resultsB = await provider.search("luxury villa interior trends Dubai");
    expect(resultsA).toEqual(resultsB);
    expect(resultsA.length).toBeGreaterThan(0);
  });

  it("records every call made to it, in order", async () => {
    const provider = new MockWebResearchProvider();
    await provider.search("first query");
    await provider.search("second query");
    expect(provider.calls).toEqual(["first query", "second query"]);
  });

  it("allows a test to override the response deterministically", async () => {
    const fixture: RawSearchResult[] = [
      {
        title: "Custom fixture result",
        url: "https://example.test/custom",
        domain: "example.test",
        snippet: "Custom snippet",
        publishedAt: "2026-01-01T00:00:00.000Z",
        retrievedAt: "2026-08-12T09:00:00.000Z",
      },
    ];
    const provider = new MockWebResearchProvider(() => fixture);
    const results = await provider.search("anything");
    expect(results).toEqual(fixture);
  });

  it("allows a test to simulate a provider throwing (failure scenario)", async () => {
    const provider = new MockWebResearchProvider(() => {
      throw new Error("simulated provider outage");
    });
    await expect(provider.search("anything")).rejects.toThrow("simulated provider outage");
  });
});
