import { describe, expect, it } from "vitest";
import { executeBoundedResearch, ResearchCallBudget } from "../../src/research/boundedExecution.js";
import { MockWebResearchProvider } from "../../src/research/mockProvider.js";
import type { RawSearchResult } from "../../src/research/types.js";

const NOW = new Date("2026-08-12T09:00:00.000Z");

describe("executeBoundedResearch", () => {
  it("returns a successful result with findings on a normal round trip", async () => {
    const provider = new MockWebResearchProvider();
    const budget = new ResearchCallBudget();
    const result = await executeBoundedResearch({
      rawQuery: "Kerala interior fit-out market competitors",
      provider,
      budget,
      now: NOW,
    });
    expect(result.success).toBe(true);
    expect(result.failureReason).toBeNull();
    expect(result.findings.length).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(1);
  });

  it("sends the sanitized query to the provider, never the raw one", async () => {
    const provider = new MockWebResearchProvider();
    const budget = new ResearchCallBudget();
    await executeBoundedResearch({
      rawQuery: "trends for customer +91 98765 43210",
      provider,
      budget,
      now: NOW,
    });
    expect(provider.calls[0]).not.toContain("98765");
  });

  it("does NOT call the provider at all when the budget is already exhausted", async () => {
    const provider = new MockWebResearchProvider();
    const budget = new ResearchCallBudget();
    budget.tryConsume(); // simulate an already-spent turn

    const result = await executeBoundedResearch({
      rawQuery: "second attempt this turn",
      provider,
      budget,
      now: NOW,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("call_limit_exceeded");
    expect(provider.calls).toHaveLength(0);
  });

  it("enforces at most one call across two sequential executions sharing a budget", async () => {
    const provider = new MockWebResearchProvider();
    const budget = new ResearchCallBudget();

    const first = await executeBoundedResearch({ rawQuery: "first", provider, budget, now: NOW });
    const second = await executeBoundedResearch({ rawQuery: "second", provider, budget, now: NOW });

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.failureReason).toBe("call_limit_exceeded");
    expect(provider.calls).toHaveLength(1);
  });

  it("never fabricates findings when the provider throws -- returns a clean failure instead", async () => {
    const provider = new MockWebResearchProvider(() => {
      throw new Error("simulated network failure");
    });
    const budget = new ResearchCallBudget();

    const result = await executeBoundedResearch({
      rawQuery: "anything",
      provider,
      budget,
      now: NOW,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("provider_error");
    expect(result.findings).toEqual([]);
  });

  it("drops malformed results instead of throwing, and reports no_relevant_sources if everything was malformed", async () => {
    const malformed = [{ title: "missing every other field" }] as unknown as RawSearchResult[];
    const provider = new MockWebResearchProvider(() => malformed);
    const budget = new ResearchCallBudget();

    const result = await executeBoundedResearch({
      rawQuery: "anything",
      provider,
      budget,
      now: NOW,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("no_relevant_sources");
    expect(result.findings).toEqual([]);
  });

  it("keeps well-formed results and silently drops only the malformed ones from a mixed batch", async () => {
    const wellFormed: RawSearchResult = {
      title: "Valid result",
      url: "https://example.test/valid",
      domain: "example.test",
      snippet: "A valid snippet.",
      publishedAt: "2026-07-01T00:00:00.000Z",
      retrievedAt: NOW.toISOString(),
    };
    const malformed = { title: "" } as unknown as RawSearchResult;
    const provider = new MockWebResearchProvider(() => [wellFormed, malformed]);
    const budget = new ResearchCallBudget();

    const result = await executeBoundedResearch({
      rawQuery: "anything",
      provider,
      budget,
      now: NOW,
    });

    expect(result.success).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.sourceUrl).toBe("https://example.test/valid");
  });

  it("reports no_relevant_sources when the provider returns zero results", async () => {
    const provider = new MockWebResearchProvider(() => []);
    const budget = new ResearchCallBudget();

    const result = await executeBoundedResearch({
      rawQuery: "anything",
      provider,
      budget,
      now: NOW,
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("no_relevant_sources");
  });
});

describe("ResearchCallBudget", () => {
  it("allows exactly one consumption", () => {
    const budget = new ResearchCallBudget();
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.tryConsume()).toBe(false);
  });

  it("reports exhaustion correctly", () => {
    const budget = new ResearchCallBudget();
    expect(budget.isExhausted).toBe(false);
    budget.tryConsume();
    expect(budget.isExhausted).toBe(true);
  });
});
