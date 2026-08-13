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

  it("escalates to requiresHuman when an unauthorized human-follow-up promise is detected", () => {
    const response = baseResponse({
      answer: "Sure, we can help with that. Our team will also follow up with you shortly.",
      requiresHuman: false,
    });
    const result = applySafetyRules(response);
    expect(result.answer).toBe(response.answer);
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("AI reply promised human/team follow-up");
  });

  it("preserves an existing handoverReason when escalating a follow-up promise", () => {
    const response = baseResponse({
      answer: "Sure, we can help with that. Our team will also follow up with you shortly.",
      requiresHuman: false,
      handoverReason: "customer_request",
    });
    const result = applySafetyRules(response);
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("customer_request");
  });

  it("leaves a genuine human-follow-up promise untouched when requiresHuman is already true", () => {
    const response = baseResponse({
      answer: "I've passed this to our team -- a team member will follow up with you shortly.",
      requiresHuman: true,
      handoverReason: "customer_request",
    });
    const result = applySafetyRules(response);
    expect(result.answer).toContain("follow up");
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("customer_request");
  });

  it("escalates a Malayalam-English mixed reply promising the team will contact the customer", () => {
    const response = baseResponse({
      answer: "ok, oru second, ഞങ്ങളുടെ team നിങ്ങളെ contact ചെയ്യും, ok ആണോ?",
      requiresHuman: false,
    });
    const result = applySafetyRules(response);
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("AI reply promised human/team follow-up");
    expect(result.answer).toBe(response.answer);
  });

  it("escalates a Malayalam-English mixed reply promising to arrange a meeting", () => {
    const response = baseResponse({
      answer: "sure, oru meeting arrange cheyyam, time njan fix cheyyam",
      requiresHuman: false,
    });
    const result = applySafetyRules(response);
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("AI reply promised human/team follow-up");
  });

  it("does not escalate an answer that merely mentions 'team' or 'call' without a follow-up promise", () => {
    const response = baseResponse({
      answer: "Our team built this product using the latest tools -- happy to answer questions!",
      requiresHuman: false,
    });
    const result = applySafetyRules(response);
    expect(result.requiresHuman).toBe(false);
  });

  it("leaves an answer with no follow-up promise unchanged", () => {
    const response = baseResponse({
      answer: "We'd love to help with your website project!",
      requiresHuman: false,
    });
    const result = applySafetyRules(response);
    expect(result).toEqual(response);
  });

  it("strips a stale voice-unsupported claim when the company has voice enabled", () => {
    const response = baseResponse({
      answer:
        "We're unable to listen to or transcribe voice messages on our end. We offer website " +
        "development and AI automation.",
    });
    const result = applySafetyRules(response, { voiceEnabled: true });
    expect(result.answer).not.toMatch(/unable to (listen|transcribe)/i);
    expect(result.answer).toBe("We offer website development and AI automation.");
  });

  it("defaults to treating voice as enabled when no context is passed", () => {
    const response = baseResponse({
      answer: "Sorry, we can't process voice messages. We offer website development.",
    });
    const result = applySafetyRules(response);
    expect(result.answer).not.toMatch(/can'?t process voice/i);
  });

  it("leaves a voice-unsupported claim untouched when the company actually has voice disabled", () => {
    const response = baseResponse({
      answer: "Sorry, we can't process voice messages here. We offer website development.",
    });
    const result = applySafetyRules(response, { voiceEnabled: false });
    expect(result.answer).toContain("can't process voice messages");
  });
});

describe("applySafetyRules -- research grounding (DRAIVA Research safety-layer fix)", () => {
  it("A. existing company-grounded answer: knowledgeSourceIds set, researchSourceCount=0, pricing claim -> no forced handover", () => {
    const response = baseResponse({
      answer: "Our website package costs ₹25,000 as listed on our pricing page.",
      knowledgeSourceIds: ["company-source"],
    });
    const result = applySafetyRules(response, { researchSourceCount: 0 });
    expect(result.requiresHuman).toBe(false);
    expect(result.handoverReason).toBeNull();
  });

  it("B. existing ungrounded answer: knowledgeSourceIds=[], researchSourceCount=0, pricing claim -> requiresHuman=true (unchanged pre-fix behavior)", () => {
    const response = baseResponse({ answer: "Our website package costs ₹25,000." });
    const result = applySafetyRules(response, { researchSourceCount: 0 });
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("missing_knowledge_grounding");
  });

  it("C. successful research answer: knowledgeSourceIds=[], researchSourceCount=3, pricing claim -> requiresHuman remains false", () => {
    const response = baseResponse({
      answer: "Several Kerala agencies publish packages in the ₹15,000/month range.",
    });
    const result = applySafetyRules(response, { researchSourceCount: 3 });
    expect(result.requiresHuman).toBe(false);
    expect(result.handoverReason).toBeNull();
    expect(result.confidence).toBe(response.confidence);
  });

  it("D. successful research answer: researchSourceCount=2, availability language -> no forced handover", () => {
    const response = baseResponse({
      answer: "Several digital marketing agencies are available in the Kerala market.",
    });
    const result = applySafetyRules(response, { researchSourceCount: 2 });
    expect(result.requiresHuman).toBe(false);
    expect(result.handoverReason).toBeNull();
  });

  it("E. research failed: researchSourceCount=0, pricing claim -> requiresHuman=true (failure never counts as grounding)", () => {
    const response = baseResponse({ answer: "Packages in this market run about ₹15,000/month." });
    // failureReason itself is not passed to applySafetyRules -- only the
    // resulting source count, which is already 0 for a failed research call
    // (see SafetyContext.researchSourceCount's doc comment in safety.ts).
    const result = applySafetyRules(response, { researchSourceCount: 0 });
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("missing_knowledge_grounding");
  });

  it("F. research started but zero findings does not count as grounding, even when explicitly passed as 0", () => {
    const response = baseResponse({ answer: "Rates in this market are typically ₹15,000/month." });
    const result = applySafetyRules(response, { researchSourceCount: 0 });
    expect(result.requiresHuman).toBe(true);
  });

  it("G. research + company knowledge both present -> no regression, still ungrounded-claim-safe", () => {
    const response = baseResponse({
      answer: "Our package costs ₹25,000, and several competitors charge ₹15,000/month.",
      knowledgeSourceIds: ["company-source"],
    });
    const result = applySafetyRules(response, { researchSourceCount: 4 });
    expect(result.requiresHuman).toBe(false);
    expect(result.handoverReason).toBeNull();
  });

  it("treats a missing researchSourceCount (omitted context field) identically to 0 -- no behavior change for callers that don't pass it", () => {
    const response = baseResponse({ answer: "Our website package costs ₹25,000." });
    const result = applySafetyRules(response, {});
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("missing_knowledge_grounding");
  });
});
