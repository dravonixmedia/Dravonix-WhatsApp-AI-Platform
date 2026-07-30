import { describe, expect, it } from "vitest";
import { applySafetyRules } from "../src/safety.js";
import type { AiStructuredResponse } from "../src/schema.js";

function baseResponse(overrides: Partial<AiStructuredResponse> = {}): AiStructuredResponse {
  return {
    answer: "We offer website development.",
    language: "en",
    intent: "general_enquiry",
    confidence: 0.9,
    replyMode: "auto",
    leadUpdates: null,
    requiresHuman: false,
    handoverReason: null,
    knowledgeSourceIds: [],
    internalNotes: null,
    ...overrides,
  };
}

describe("applySafetyRules", () => {
  it("forces requiresHuman when a price is stated without any cited knowledge source", () => {
    const response = baseResponse({ answer: "Our website package costs ₹25,000." });
    const result = applySafetyRules(response);
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("missing_knowledge_grounding");
    expect(result.confidence).toBeLessThanOrEqual(0.4);
  });

  it("does not override an ungrounded-claim response that already cites a knowledge source", () => {
    const response = baseResponse({
      answer: "Our website package costs ₹25,000 as listed on our pricing page.",
      knowledgeSourceIds: ["pricing-source-1"],
    });
    const result = applySafetyRules(response);
    expect(result.requiresHuman).toBe(false);
    expect(result.handoverReason).toBeNull();
  });

  it("leaves a response with no pricing/availability claim untouched", () => {
    const response = baseResponse({ answer: "We'd love to help with your website project!" });
    const result = applySafetyRules(response);
    expect(result).toEqual(response);
  });

  it("flags an ungrounded business-hours claim", () => {
    const response = baseResponse({ answer: "We are open from 9am to 6pm every day." });
    const result = applySafetyRules(response);
    expect(result.requiresHuman).toBe(true);
  });

  it("preserves an existing handoverReason instead of overwriting it", () => {
    const response = baseResponse({
      answer: "That item is available for ₹500.",
      handoverReason: "customer_request",
    });
    const result = applySafetyRules(response);
    expect(result.handoverReason).toBe("customer_request");
  });
});
