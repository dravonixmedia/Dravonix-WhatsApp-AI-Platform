import type { HandoverWorkerRepository } from "./repository.js";

export interface TriggerHandoverInput {
  conversationId: string;
  reason: string;
  sourceMessageId: string | null;
  sourceType: "text" | "voice" | "system";
  /** Required only when sourceMessageId is null (a system-sourced handover). */
  idempotencyKey?: string | null;
}

/**
 * The one entry point every trusted background source (message-consumer,
 * voice-consumer, and any future one) must call to request a handover
 * (final plan section 13). Durably no-ops on a redelivery of the same
 * originating message, even long after the conversation has cycled all the
 * way back through ai_active -- see trigger_handover in migration 12 and
 * handover_events' table comment for why this can't be a `state <>
 * 'ai_active'` check alone.
 */
export async function triggerHandoverAtomic(
  repo: HandoverWorkerRepository,
  input: TriggerHandoverInput,
) {
  return repo.triggerHandover(input);
}
