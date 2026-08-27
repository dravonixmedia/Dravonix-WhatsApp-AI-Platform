import type { AiUsage } from "./provider.js";

export interface AiUsageRecorderInput {
  companyId: string;
  conversationId: string | null;
  /**
   * The durable inbound message id (MessageJobPayload.messageId /
   * VoiceJobPayload.messageId) this generation call was made on behalf of --
   * stable across every queue redelivery/retry of the same logical job.
   * Included for correlation/traceability in the raw usage_events table
   * only -- NOT sufficient on its own for idempotency (see callId below).
   * A queue redelivery that genuinely re-invokes Claude keeps the same
   * messageId across both invocations, by design, since it's the same
   * inbound message; deriving the idempotency key from messageId alone
   * would silently collapse two real, separately-billed provider calls into
   * one recorded set, undercounting actual provider consumption (ADR-0004
   * correction, P0 usage-repair independent review).
   */
  messageId: string;
  /**
   * Stable identifier for the SPECIFIC generateValidatedResponse invocation
   * this usage came from (OrchestrationResult.callId) -- generated fresh,
   * once, at the top of that function, before any real provider.generate()
   * call. This -- not messageId -- is what concrete recorders must key
   * usage_events.idempotency_key on (e.g. `${messageId}:${callId}:
   * claude_requests`), so that:
   *   - a queue redelivery that genuinely re-invokes Claude gets a NEW
   *     callId and is recorded as separate, additional provider consumption
   *     (never silently dropped as a "duplicate" of the first attempt); and
   *   - persisting the SAME invocation's usage more than once (e.g. a bug,
   *     or an explicit retry of only the write) still collides harmlessly
   *     on the same key instead of double-counting, since callId does not
   *     change across repeated persistence attempts for one invocation.
   */
  callId: string;
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
