import { describe, expect, it, vi } from "vitest";
import { generateValidatedResponse } from "../../src/orchestrate.js";
import { MockAiProvider } from "../../src/providers/mockProvider.js";
import { makeInput } from "../fixtures.js";
import type { LiveResearchExecutionMetadata } from "../../src/research/types.js";

function validJsonResponder() {
  return JSON.stringify({
    answer: "Answer",
    language: "en",
    intent: "general_enquiry",
    confidence: 0.8,
    replyMode: "auto",
    leadUpdates: null,
    requiresHuman: false,
    handoverReason: null,
    knowledgeSourceIds: [],
    internalNotes: null,
  });
}

describe("generateValidatedResponse -- DRAIVA Research live diagnostics (onExecuted)", () => {
  it("does not call onExecuted when research.enabled is false", async () => {
    const provider = new MockAiProvider(validJsonResponder);
    const onExecuted = vi.fn();

    await generateValidatedResponse(
      { provider, research: { enabled: false, onExecuted } },
      makeInput({ knowledge: [] }),
    );

    expect(onExecuted).not.toHaveBeenCalled();
  });

  it("reports researchStarted=false when the provider performed zero searches", async () => {
    const provider = new MockAiProvider(validJsonResponder);
    const onExecuted = vi.fn();

    await generateValidatedResponse(
      { provider, research: { enabled: true, onExecuted } },
      makeInput({ knowledge: [{ sourceId: "s1", title: "t", content: "c", relevance: 0.9 }] }),
    );

    expect(onExecuted).toHaveBeenCalledTimes(1);
    const diagnostics = onExecuted.mock.calls[0]![0];
    expect(diagnostics.researchStarted).toBe(false);
    expect(diagnostics.researchCompleted).toBe(false);
    expect(diagnostics.sourceCount).toBe(0);
    expect(diagnostics.failureCategory).toBeNull();
    expect(diagnostics.researchReason).toContain("relevant enough");
  });

  it("reports researchStarted/Completed=true and sourceCount from the provider's research metadata", async () => {
    const research: LiveResearchExecutionMetadata = {
      searchesPerformed: 1,
      searchQueries: ["Kerala interior fit-out market"],
      findings: [
        {
          sourceUrl: "https://example.test/a",
          sourceTitle: "A",
          sourceDomain: "example.test",
          publishedAt: null,
          retrievedAt: "2026-08-12T09:00:00.000Z",
          relevance: 1,
          authorityTier: "general_web",
          keyFindings: "finding text",
          origin: "external_research",
        },
      ],
      failureReason: null,
    };
    const provider = new MockAiProvider();
    const originalGenerate = provider.generate.bind(provider);
    provider.generate = async (input, repairInstruction) => {
      const result = await originalGenerate(input, repairInstruction);
      return { ...result, research };
    };
    const onExecuted = vi.fn();

    const outcome = await generateValidatedResponse(
      { provider, research: { enabled: true, onExecuted } },
      makeInput({ knowledge: [] }),
    );

    expect(onExecuted).toHaveBeenCalledTimes(1);
    const diagnostics = onExecuted.mock.calls[0]![0];
    expect(diagnostics.researchStarted).toBe(true);
    expect(diagnostics.researchCompleted).toBe(true);
    expect(diagnostics.sourceCount).toBe(1);
    expect(diagnostics.researchLatencyMs).toBeGreaterThanOrEqual(0);
    expect(outcome.research).toEqual(research);
  });

  it("reports researchCompleted=false when the provider reports a failureReason", async () => {
    const research: LiveResearchExecutionMetadata = {
      searchesPerformed: 1,
      searchQueries: ["q"],
      findings: [],
      failureReason: "rate_limited",
    };
    const provider = new MockAiProvider();
    const originalGenerate = provider.generate.bind(provider);
    provider.generate = async (input, repairInstruction) => {
      const result = await originalGenerate(input, repairInstruction);
      return { ...result, research };
    };
    const onExecuted = vi.fn();

    await generateValidatedResponse(
      { provider, research: { enabled: true, onExecuted } },
      makeInput({ knowledge: [] }),
    );

    const diagnostics = onExecuted.mock.calls[0]![0];
    expect(diagnostics.researchStarted).toBe(true);
    expect(diagnostics.researchCompleted).toBe(false);
    expect(diagnostics.failureCategory).toBe("rate_limited");
  });

  it("carries research metadata through even when a repair attempt was needed (research only ever happens on the first attempt)", async () => {
    const research: LiveResearchExecutionMetadata = {
      searchesPerformed: 1,
      searchQueries: ["q"],
      findings: [],
      failureReason: null,
    };
    let call = 0;
    const provider = new MockAiProvider();
    provider.generate = async (_input, _repairInstruction) => {
      call += 1;
      if (call === 1) {
        return {
          rawText: "not valid json",
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          research,
        };
      }
      return {
        rawText: JSON.stringify({
          answer: "Repaired",
          language: "en",
          intent: "x",
          confidence: 0.5,
          replyMode: "auto",
          leadUpdates: null,
          requiresHuman: false,
          handoverReason: null,
          knowledgeSourceIds: [],
          internalNotes: null,
        }),
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      };
    };

    const outcome = await generateValidatedResponse({ provider }, makeInput({ knowledge: [] }));

    expect(outcome.repaired).toBe(true);
    expect(outcome.research).toEqual(research);
  });
});
