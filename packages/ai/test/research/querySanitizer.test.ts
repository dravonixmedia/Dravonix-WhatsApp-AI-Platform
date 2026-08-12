import { describe, expect, it } from "vitest";
import { sanitizeResearchQuery } from "../../src/research/querySanitizer.js";

describe("sanitizeResearchQuery", () => {
  it("is safe (no violations) for a clean, public topic query", () => {
    const result = sanitizeResearchQuery("luxury villa interior design trends Dubai 2026");
    expect(result.safe).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.query).toBe("luxury villa interior design trends Dubai 2026");
  });

  it("redacts a phone number embedded in the query text and flags it", () => {
    const result = sanitizeResearchQuery("interior trends for customer +91 98765 43210");
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.type === "phone_number")).toBe(true);
    expect(result.query).not.toContain("98765");
  });

  it("redacts a UUID-shaped internal ID pattern and flags it", () => {
    const result = sanitizeResearchQuery(
      "research for conversation 3fa85f64-5717-4562-b3fc-2c963f66afa6",
    );
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.type === "internal_id")).toBe(true);
    expect(result.query).not.toContain("3fa85f64");
  });

  it("redacts a credential-shaped token and flags it", () => {
    const result = sanitizeResearchQuery("use api_key for lookup then research villa trends");
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.type === "credential")).toBe(true);
  });

  it("redacts the exact customer phone number supplied via context, even without a recognizable pattern shape", () => {
    const result = sanitizeResearchQuery("research trends for 919876543210 customer", {
      phoneNumber: "919876543210",
    });
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.type === "phone_number")).toBe(true);
    expect(result.query).not.toContain("919876543210");
  });

  it("redacts the exact conversation ID supplied via context", () => {
    const conversationId = "conv-9f8e7d6c5b4a";
    const result = sanitizeResearchQuery(`trends related to ${conversationId}`, { conversationId });
    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.type === "internal_id")).toBe(true);
    expect(result.query).not.toContain(conversationId);
  });

  it("redacts the exact contact ID supplied via context", () => {
    const contactId = "contact-abc123456789";
    const result = sanitizeResearchQuery(`about ${contactId}`, { contactId });
    expect(result.violations.some((v) => v.type === "internal_id")).toBe(true);
  });

  it("redacts a supplied credential value even if it doesn't match a generic pattern", () => {
    const secret = "sunshine-super-secret-value";
    const result = sanitizeResearchQuery(`context including ${secret}`, { credentials: [secret] });
    expect(result.violations.some((v) => v.type === "credential")).toBe(true);
    expect(result.query).not.toContain(secret);
  });

  it("redacts a verbatim prior conversation history snippet", () => {
    const history = "My villa renovation budget is around 50 lakh rupees total";
    const result = sanitizeResearchQuery(`research based on: ${history}`, {
      conversationHistorySnippets: [history],
    });
    expect(result.violations.some((v) => v.type === "conversation_history")).toBe(true);
    expect(result.query).not.toContain(history);
  });

  it("redacts a private document reference", () => {
    const doc = "customer-uploaded-floorplan-2026.pdf";
    const result = sanitizeResearchQuery(`considering ${doc}`, {
      privateDocumentReferences: [doc],
    });
    expect(result.violations.some((v) => v.type === "private_document_reference")).toBe(true);
    expect(result.query).not.toContain(doc);
  });

  it("does not flag a short, generic context value as a false positive", () => {
    const result = sanitizeResearchQuery("villa interior trends", { phoneNumber: "" });
    expect(result.safe).toBe(true);
  });

  it("is a pure function -- calling it twice with the same input yields the same output", () => {
    const input = "villa interior trends Dubai";
    expect(sanitizeResearchQuery(input)).toEqual(sanitizeResearchQuery(input));
  });
});
