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

  it("strips an unauthorized human-follow-up promise when requiresHuman is false", () => {
    const response = baseResponse({
      answer: "Sure, we can help with that. Our team will also follow up with you shortly.",
      requiresHuman: false,
    });
    const result = applySafetyRules(response);
    expect(result.answer).not.toMatch(/follow up/i);
    expect(result.answer).toBe("Sure, we can help with that.");
    expect(result.requiresHuman).toBe(false);
  });

  it("leaves a genuine human-follow-up promise untouched when requiresHuman is true", () => {
    const response = baseResponse({
      answer: "I've passed this to our team -- a team member will follow up with you shortly.",
      requiresHuman: true,
      handoverReason: "customer_request",
    });
    const result = applySafetyRules(response);
    expect(result.answer).toContain("follow up");
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

  it("suppresses an escalation on a text enquiry whose reason cites stale voice/transcript history", () => {
    // Reproduces the exact regression: a conversation was returned to
    // ai_active, then an ordinary new text message re-triggered handover
    // because Claude's reasoning was still anchored on an old, unrelated
    // voice message elsewhere in the conversation history.
    const response = baseResponse({
      answer: "Thanks for reaching out -- let me get someone to help.",
      requiresHuman: true,
      handoverReason:
        "Customer has sent multiple voice messages (unreadable) and repeated greetings, indicating urgency.",
    });
    const result = applySafetyRules(response, { currentMessageIsVoice: false });
    expect(result.requiresHuman).toBe(false);
    expect(result.handoverReason).toBeNull();
  });

  it("does not suppress a genuine escalation when the current message actually is a voice note", () => {
    const response = baseResponse({
      answer: "Let me get a team member to help with that.",
      requiresHuman: true,
      handoverReason: "Customer's voice message could not be transcribed after a retry.",
    });
    const result = applySafetyRules(response, { currentMessageIsVoice: true });
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe(
      "Customer's voice message could not be transcribed after a retry.",
    );
  });

  it("does not suppress a text-enquiry escalation for an unrelated, non-voice reason", () => {
    const response = baseResponse({
      answer: "Let me get a team member to help with that.",
      requiresHuman: true,
      handoverReason: "customer_request",
    });
    const result = applySafetyRules(response, { currentMessageIsVoice: false });
    expect(result.requiresHuman).toBe(true);
    expect(result.handoverReason).toBe("customer_request");
  });

  it("defaults currentMessageIsVoice to false, still suppressing a stale voice reason when omitted", () => {
    const response = baseResponse({
      answer: "Let me get a team member to help with that.",
      requiresHuman: true,
      handoverReason: "Repeated unreadable voice notes from this customer.",
    });
    const result = applySafetyRules(response);
    expect(result.requiresHuman).toBe(false);
  });
});
