import { describe, expect, it, vi } from "vitest";
import { generateValidatedResponse } from "../../src/orchestrate.js";
import { MockAiProvider } from "../../src/providers/mockProvider.js";
import { makeInput } from "../fixtures.js";

describe("DRAIVA Research Phase 1 orchestrator integration seam", () => {
  it("preserves the existing flow byte-for-byte when `research` is omitted (every current caller)", async () => {
    const provider = new MockAiProvider();
    const input = makeInput();

    const withoutSeam = await generateValidatedResponse({ provider }, input);
    const providerAfterFirst = provider.calls.length;

    const provider2 = new MockAiProvider();
    const withSeamFieldAbsent = await generateValidatedResponse({ provider: provider2 }, input);

    expect(withoutSeam.response).toEqual(withSeamFieldAbsent.response);
    expect(providerAfterFirst).toBe(1);
    expect(provider2.calls).toHaveLength(1);
  });

  it("does not evaluate or report a research decision when `research.enabled` is false", async () => {
    const provider = new MockAiProvider();
    const onDecision = vi.fn();

    await generateValidatedResponse(
      { provider, research: { enabled: false, onDecision } },
      makeInput(),
    );

    expect(onDecision).not.toHaveBeenCalled();
  });

  it("reports company_knowledge_sufficient when enabled and retrieved knowledge is highly relevant", async () => {
    const provider = new MockAiProvider();
    const onDecision = vi.fn();

    await generateValidatedResponse(
      { provider, research: { enabled: true, onDecision } },
      makeInput({ knowledge: [{ sourceId: "s1", title: "FAQ", content: "...", relevance: 0.95 }] }),
    );

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0]?.[0]).toMatchObject({
      decision: "company_knowledge_sufficient",
    });
  });

  it("reports eligible_for_model_decision when enabled and knowledge is empty, without altering the response", async () => {
    const provider = new MockAiProvider();
    const onDecision = vi.fn();

    const result = await generateValidatedResponse(
      { provider, research: { enabled: true, onDecision } },
      makeInput({ knowledge: [] }),
    );

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0]?.[0]).toMatchObject({
      decision: "eligible_for_model_decision",
    });
    // The seam is observational only in Phase 1 -- the actual structured response is untouched.
    expect(result.response.answer).toContain("Dravonix Media");
    expect(provider.calls).toHaveLength(1);
  });

  it("never calls a research provider itself -- the seam only evaluates eligibility, it does not execute research", async () => {
    const provider = new MockAiProvider();
    const onDecision = vi.fn();

    await generateValidatedResponse(
      { provider, research: { enabled: true, onDecision } },
      makeInput({ knowledge: [] }),
    );

    // Only the AI provider is a dependency here -- there is no research
    // provider parameter on OrchestrationDependencies in Phase 1, so there is
    // nothing for the orchestrator to call even if it wanted to.
    expect(provider.calls).toHaveLength(1);
  });
});
