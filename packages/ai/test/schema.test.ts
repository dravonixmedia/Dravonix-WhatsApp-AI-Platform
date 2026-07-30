import { describe, expect, it } from "vitest";
import { aiStructuredResponseSchema } from "../src/schema.js";

const validResponse = {
  answer: "We offer website development and AI automation services.",
  language: "en",
  intent: "general_enquiry",
  confidence: 0.9,
  replyMode: "auto",
  leadUpdates: null,
  requiresHuman: false,
  handoverReason: null,
  knowledgeSourceIds: ["source-1"],
  internalNotes: null,
};

describe("aiStructuredResponseSchema", () => {
  it("accepts a valid structured response", () => {
    expect(aiStructuredResponseSchema.safeParse(validResponse).success).toBe(true);
  });

  it("rejects a response missing the answer field", () => {
    const rest: Partial<typeof validResponse> = { ...validResponse };
    delete rest.answer;
    expect(aiStructuredResponseSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a confidence value outside [0, 1]", () => {
    expect(
      aiStructuredResponseSchema.safeParse({ ...validResponse, confidence: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects an invalid replyMode value", () => {
    expect(
      aiStructuredResponseSchema.safeParse({ ...validResponse, replyMode: "shout" }).success,
    ).toBe(false);
  });

  it("rejects knowledgeSourceIds that is not an array", () => {
    expect(
      aiStructuredResponseSchema.safeParse({ ...validResponse, knowledgeSourceIds: "source-1" })
        .success,
    ).toBe(false);
  });

  it("accepts partial leadUpdates with some fields null", () => {
    const withLead = {
      ...validResponse,
      leadUpdates: { name: "Asha", service: "Website Development", budget: null },
    };
    expect(aiStructuredResponseSchema.safeParse(withLead).success).toBe(true);
  });
});
