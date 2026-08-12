import { describe, expect, it } from "vitest";
import { evaluateResearchEligibility } from "../../src/research/eligibility.js";
import type { RetrievedKnowledgeSnippet } from "../../src/provider.js";

function snippet(relevance: number): RetrievedKnowledgeSnippet {
  return { sourceId: "s1", title: "t", content: "c", relevance };
}

describe("evaluateResearchEligibility (company-knowledge-first decision contract)", () => {
  it("decides company_knowledge_sufficient when a highly relevant snippet was retrieved", () => {
    const result = evaluateResearchEligibility({
      knowledge: [snippet(0.9)],
      researchEnabled: true,
    });
    expect(result.decision).toBe("company_knowledge_sufficient");
    expect(result.bestKnowledgeRelevance).toBe(0.9);
  });

  it("decides eligible_for_model_decision when knowledge is empty and research is enabled", () => {
    const result = evaluateResearchEligibility({ knowledge: [], researchEnabled: true });
    expect(result.decision).toBe("eligible_for_model_decision");
    expect(result.bestKnowledgeRelevance).toBe(0);
  });

  it("decides eligible_for_model_decision when the best relevance is below the sufficiency threshold", () => {
    const result = evaluateResearchEligibility({
      knowledge: [snippet(0.2)],
      researchEnabled: true,
    });
    expect(result.decision).toBe("eligible_for_model_decision");
  });

  it("decides research_disabled when research is not enabled, regardless of knowledge", () => {
    const result = evaluateResearchEligibility({ knowledge: [], researchEnabled: false });
    expect(result.decision).toBe("research_disabled");
  });

  it("prioritizes research_disabled over knowledge sufficiency (disabled always wins)", () => {
    const result = evaluateResearchEligibility({
      knowledge: [snippet(0.99)],
      researchEnabled: false,
    });
    expect(result.decision).toBe("research_disabled");
  });

  it("uses the highest relevance among multiple retrieved snippets", () => {
    const result = evaluateResearchEligibility({
      knowledge: [snippet(0.1), snippet(0.7), snippet(0.3)],
      researchEnabled: true,
    });
    expect(result.bestKnowledgeRelevance).toBe(0.7);
    expect(result.decision).toBe("company_knowledge_sufficient");
  });

  it("respects a custom sufficientRelevance threshold", () => {
    const result = evaluateResearchEligibility({
      knowledge: [snippet(0.5)],
      researchEnabled: true,
      sufficientRelevance: 0.4,
    });
    expect(result.decision).toBe("company_knowledge_sufficient");
  });

  it("never itself decides to research -- eligible_for_model_decision only narrows the choice, it does not trigger anything", () => {
    const result = evaluateResearchEligibility({ knowledge: [], researchEnabled: true });
    expect(result.decision).not.toBe("research");
    expect([
      "company_knowledge_sufficient",
      "research_disabled",
      "eligible_for_model_decision",
    ]).toContain(result.decision);
  });
});
