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
