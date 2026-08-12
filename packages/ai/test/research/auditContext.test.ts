import { describe, expect, it } from "vitest";
import { buildResearchAuditRecord } from "../../src/research/auditContext.js";
import type { ResearchToolResult } from "../../src/research/types.js";

function makeResult(overrides: Partial<ResearchToolResult> = {}): ResearchToolResult {
  return {
    query: "villa interior trends Dubai",
    findings: [],
    success: true,
    failureReason: null,
    executedAt: "2026-08-12T09:00:00.000Z",
    ...overrides,
  };
}

describe("buildResearchAuditRecord (tenant isolation metadata)", () => {
  it("carries the caller's companyId and conversationId through unchanged", () => {
    const record = buildResearchAuditRecord(
      { companyId: "company-a", conversationId: "conversation-a" },
      makeResult(),
    );
    expect(record.companyId).toBe("company-a");
    expect(record.conversationId).toBe("conversation-a");
  });

  it("throws rather than building a record with a missing companyId", () => {
    expect(() =>
      buildResearchAuditRecord({ companyId: "", conversationId: "conversation-a" }, makeResult()),
    ).toThrow();
  });

  it("throws rather than building a record with a missing conversationId", () => {
    expect(() =>
      buildResearchAuditRecord({ companyId: "company-a", conversationId: "" }, makeResult()),
    ).toThrow();
  });

  it("never derives companyId/conversationId from the research result itself -- two different companies asking the same public question get distinctly tenant-scoped records", () => {
    const sharedResult = makeResult({ query: "same public question for everyone" });

    const recordForA = buildResearchAuditRecord(
      { companyId: "company-a", conversationId: "conv-a" },
      sharedResult,
    );
    const recordForB = buildResearchAuditRecord(
      { companyId: "company-b", conversationId: "conv-b" },
      sharedResult,
    );

    expect(recordForA.companyId).not.toBe(recordForB.companyId);
    expect(recordForA.conversationId).not.toBe(recordForB.conversationId);
    // The public research content itself is legitimately identical -- only the tenant scoping differs.
    expect(recordForA.query).toBe(recordForB.query);
  });

  it("captures source count, success, and failure reason from the result", () => {
    const failed = makeResult({ success: false, failureReason: "provider_error", findings: [] });
    const record = buildResearchAuditRecord({ companyId: "c1", conversationId: "conv1" }, failed);
    expect(record.success).toBe(false);
    expect(record.failureReason).toBe("provider_error");
    expect(record.sourceCount).toBe(0);
  });
});
