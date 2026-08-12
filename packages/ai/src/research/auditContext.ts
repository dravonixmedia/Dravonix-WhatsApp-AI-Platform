import type { ResearchFailureReason, ResearchToolResult } from "./types.js";

/**
 * Tenant isolation metadata for research (Phase 1 design report, section
 * 16). No research table/migration exists yet -- this is the shape a future
 * audit-log write would use, and the pure function below is what any future
 * persistence layer should call rather than building its own record. Both
 * fields are always required and always taken from the caller's
 * already-authorized context; a research result never carries its own
 * companyId/conversationId (it only contains public web data), so a record
 * can never be mis-attributed to the wrong tenant based on anything the
 * research query or findings contained.
 */
export interface ResearchAuditContext {
  companyId: string;
  conversationId: string;
}

export interface ResearchAuditRecord {
  companyId: string;
  conversationId: string;
  query: string;
  sourceCount: number;
  success: boolean;
  failureReason: ResearchFailureReason | null;
  executedAt: string;
}

export function buildResearchAuditRecord(
  context: ResearchAuditContext,
  result: ResearchToolResult,
): ResearchAuditRecord {
  if (!context.companyId || !context.conversationId) {
    throw new Error("buildResearchAuditRecord requires both companyId and conversationId");
  }
  return {
    companyId: context.companyId,
    conversationId: context.conversationId,
    query: result.query,
    sourceCount: result.findings.length,
    success: result.success,
    failureReason: result.failureReason,
    executedAt: result.executedAt,
  };
}
