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

  it("rejects a malformed handover decision: requiresHuman true with a null handoverReason", () => {
    const result = aiStructuredResponseSchema.safeParse({
      ...validResponse,
      requiresHuman: true,
      handoverReason: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed handover decision: requiresHuman true with an empty-string handoverReason", () => {
    const result = aiStructuredResponseSchema.safeParse({
      ...validResponse,
      requiresHuman: true,
      handoverReason: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("accepts requiresHuman true paired with a real handoverReason", () => {
    const result = aiStructuredResponseSchema.safeParse({
      ...validResponse,
      requiresHuman: true,
      handoverReason: "customer_requested_human",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a complete, valid Malayalam Unicode response", () => {
    const result = aiStructuredResponseSchema.safeParse({
      ...validResponse,
      answer:
        "നിങ്ങളുടെ ചോദ്യത്തിന് നന്ദി. ഞങ്ങൾ വെബ്സൈറ്റ് ഡെവലപ്മെന്റ് സേവനങ്ങൾ വാഗ്ദാനം ചെയ്യുന്നു.",
      language: "ml",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a Malayalam-English mixed-script response", () => {
    const result = aiStructuredResponseSchema.safeParse({
      ...validResponse,
      answer: "നന്ദി! We offer website development and AI automation services.",
      language: "ml",
    });
    expect(result.success).toBe(true);
  });
});
