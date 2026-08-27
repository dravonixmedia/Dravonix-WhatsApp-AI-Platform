import type { AiUsage } from "./provider.js";

export interface AiUsageRecorderInput {
  companyId: string;
  conversationId: string | null;
  /**
   * The durable inbound message id (MessageJobPayload.messageId /
   * VoiceJobPayload.messageId) this generation call was made on behalf of --
   * stable across every queue redelivery/retry of the same logical job.
   * Concrete recorders derive deterministic usage_events.idempotency_key
   * values from this (e.g. `${messageId}:claude_requests`), never a random
   * UUID, so a retried job's re-recorded usage collides harmlessly with the
   * already-written row instead of double-counting.
   */
  messageId: string;
  usage: AiUsage;
  /**
   * How many real provider.generate() calls this usage reflects -- 1 for a
   * single attempt, 2 when a repair attempt was also made (OrchestrationResult.repaired).
   * `usage` already sums tokens across every attempt this covers.
   */
  requestCount: number;
  requestSucceeded: boolean;
}

export interface AiUsageRecorder {
  recordAiUsage(input: AiUsageRecorderInput): Promise<void>;
}

/**
 * Records Claude token usage against usage_events (Master Prompt section 26),
 * independent of whether the call ultimately succeeded validation, so cost
 * tracking and plan-limit enforcement stay accurate even when a repair or
 * fallback path was used. A real provider.generate() round trip -- meaning
 * `generateValidatedResponse` returned rather than throwing -- always
 * consumed real, billable tokens regardless of whether the structured output
 * was valid; only a hard provider failure (network/auth error, no return
 * value at all) should ever result in no usage being recorded for a turn.
 */
export async function recordAiUsage(
  recorder: AiUsageRecorder,
  input: AiUsageRecorderInput,
): Promise<void> {
  await recorder.recordAiUsage(input);
}
