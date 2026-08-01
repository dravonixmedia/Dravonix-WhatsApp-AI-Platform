import { describe, expect, it, vi } from "vitest";
import { generateValidatedResponse } from "../src/orchestrate.js";
import { MockAiProvider } from "../src/providers/mockProvider.js";
import { makeInput } from "./fixtures.js";

describe("generateValidatedResponse", () => {
  it("returns a valid structured response on the first attempt without repairing", async () => {
    const provider = new MockAiProvider();
    const result = await generateValidatedResponse({ provider }, makeInput());

    expect(result.repaired).toBe(false);
    expect(result.usedFallback).toBe(false);
    expect(result.response.answer).toContain("Dravonix Media");
    expect(provider.calls).toHaveLength(1);
  });

  it("repairs an invalid first response and succeeds on the second attempt", async () => {
    let call = 0;
    const provider = new MockAiProvider(() => {
      call += 1;
      if (call === 1) return "not valid json at all";
      return JSON.stringify({
        answer: "Repaired answer",
        language: "en",
        intent: "general_enquiry",
        confidence: 0.7,
        replyMode: "auto",
        leadUpdates: null,
        requiresHuman: false,
        handoverReason: null,
        knowledgeSourceIds: [],
        internalNotes: null,
      });
    });

    const result = await generateValidatedResponse({ provider }, makeInput());

    expect(result.repaired).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.response.answer).toBe("Repaired answer");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.repairInstruction).toBeDefined();
  });

  it("falls back to a safe static response when both attempts are invalid, and notifies onValidationFailure", async () => {
    const provider = new MockAiProvider(() => "still not valid json");
    const onValidationFailure = vi.fn();

    const result = await generateValidatedResponse({ provider, onValidationFailure }, makeInput());

    expect(result.usedFallback).toBe(true);
    expect(result.response.requiresHuman).toBe(true);
    expect(result.response.answer).toBe(
      "Automated assistance is temporarily unavailable. Our team will respond as soon as possible.",
    );
    expect(onValidationFailure).toHaveBeenCalledTimes(1);
  });

  it("never surfaces raw JSON as the customer-facing answer even when both attempts fail", async () => {
    const provider = new MockAiProvider(() => "{ this is not json");
    const result = await generateValidatedResponse({ provider }, makeInput());
    expect(result.response.answer).not.toContain("{");
  });

  it("sums usage across both the original and repair attempts", async () => {
    const provider = new MockAiProvider(() => "invalid");
    const result = await generateValidatedResponse({ provider }, makeInput());
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
  });

  it("parses a valid response even when wrapped in a markdown code fence", async () => {
    const validResponse = {
      answer: "Fenced answer",
      language: "en",
      intent: "general_enquiry",
      confidence: 0.8,
      replyMode: "auto",
      leadUpdates: null,
      requiresHuman: false,
      handoverReason: null,
      knowledgeSourceIds: [],
      internalNotes: null,
    };
    const provider = new MockAiProvider(
      () => "```json\n" + JSON.stringify(validResponse) + "\n```",
    );

    const result = await generateValidatedResponse({ provider }, makeInput());

    expect(result.usedFallback).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.response.answer).toBe("Fenced answer");
    expect(provider.calls).toHaveLength(1);
  });

  it("parses a valid response even with stray prose before and after the JSON object", async () => {
    const validResponse = {
      answer: "Prose-wrapped answer",
      language: "en",
      intent: "general_enquiry",
      confidence: 0.8,
      replyMode: "auto",
      leadUpdates: null,
      requiresHuman: false,
      handoverReason: null,
      knowledgeSourceIds: [],
      internalNotes: null,
    };
    const provider = new MockAiProvider(
      () =>
        "Here is my response:\n" + JSON.stringify(validResponse) + "\nLet me know if that helps!",
    );

    const result = await generateValidatedResponse({ provider }, makeInput());

    expect(result.usedFallback).toBe(false);
    expect(result.response.answer).toBe("Prose-wrapped answer");
  });

  it("does not repair (and reports low confidence) when the model itself signals low confidence", async () => {
    const provider = new MockAiProvider(() =>
      JSON.stringify({
        answer: "I'm not fully sure, let me connect you with our team.",
        language: "en",
        intent: "unclear",
        confidence: 0.2,
        replyMode: "auto",
        leadUpdates: null,
        requiresHuman: true,
        handoverReason: "low_confidence",
        knowledgeSourceIds: [],
        internalNotes: null,
      }),
    );

    const result = await generateValidatedResponse({ provider }, makeInput());
    expect(result.repaired).toBe(false);
    expect(result.response.requiresHuman).toBe(true);
    expect(result.response.confidence).toBeLessThan(0.55);
  });
});
