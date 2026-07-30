import type { AiUsage } from "./provider.js";

export interface AiUsageRecorder {
  recordAiUsage(input: {
    companyId: string;
    conversationId: string | null;
    usage: AiUsage;
    requestSucceeded: boolean;
  }): Promise<void>;
}

/**
 * Records Claude token usage against usage_events (Master Prompt section 26),
 * independent of whether the call ultimately succeeded validation, so cost
 * tracking and plan-limit enforcement stay accurate even when a repair or
 * fallback path was used.
 */
export async function recordAiUsage(
  recorder: AiUsageRecorder,
  input: {
    companyId: string;
    conversationId: string | null;
    usage: AiUsage;
    requestSucceeded: boolean;
  },
): Promise<void> {
  await recorder.recordAiUsage(input);
}
