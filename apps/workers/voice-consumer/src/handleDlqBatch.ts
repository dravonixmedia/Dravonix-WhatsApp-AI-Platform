import type { Logger } from "@dravonix/observability";
import type { VoiceConsumerRepository } from "./repository.js";
import type { VoiceJobPayload } from "./processVoiceJob.js";

/**
 * Minimal shapes this handler depends on -- deliberately structural (not
 * imported from worker.ts) so it stays trivially unit-testable without a
 * real Cloudflare Queues binding.
 */
export interface DlqMessage {
  readonly body: VoiceJobPayload;
  ack(): void;
}

export interface DlqBatch {
  readonly messages: readonly DlqMessage[];
}

export interface VoiceDlqDeps {
  repo: Pick<VoiceConsumerRepository, "recordJobFailure">;
  logger: Logger;
  /** The DLQ's own queue name, e.g. "dravonix-voice-queue-staging-dlq". */
  queueName: string;
}

/**
 * Handles a batch of messages that Cloudflare Queues has already routed to
 * the voice dead-letter queue after the main queue's configured max_retries
 * was exhausted (voice pipeline reliability phase 9/10).
 *
 * Scope is deliberately narrow: record durable, sanitized failure metadata
 * for triage, then ack. This function must NEVER re-transcribe, call the AI
 * provider, or send/resend a WhatsApp message -- replaying a DLQ message's
 * business workflow is an explicit, separate, later action, not something
 * a DLQ consumer does automatically.
 *
 * NOT WIRED TO A LIVE QUEUE BINDING YET -- see wrangler.toml's comment next
 * to `dead_letter_queue`. Adding a `[[env.staging.queues.consumers]]` entry
 * for `dravonix-voice-queue-staging-dlq` would start draining the existing
 * staging backlog immediately; that requires explicit approval first (see
 * the DLQ SAFETY section of the final report).
 */
export async function handleVoiceDlqBatch(deps: VoiceDlqDeps, batch: DlqBatch): Promise<void> {
  for (const message of batch.messages) {
    const payload = message.body;
    try {
      await deps.repo.recordJobFailure({
        companyId: payload.companyId ?? null,
        queueName: deps.queueName,
        jobId: payload.jobId,
        correlationId: payload.correlationId,
        messageId: payload.messageId,
        stage: "dead_letter_queue",
        attempt: payload.attempt,
        category: "exhausted_retries",
        retryable: false,
        errorSummary:
          "Voice job exhausted all main-queue retries and was routed to the dead-letter queue.",
      });
    } catch (error) {
      // Even a failed recording must not fall back to replaying the
      // business workflow -- ack regardless (PHASE 10: a DLQ handler is for
      // triage only). The failure is still visible via this log line.
      deps.logger.error("Failed to record DLQ job failure", {
        error: error instanceof Error ? error.message : String(error),
        companyId: payload.companyId,
        queueName: deps.queueName,
      });
    }
    message.ack();
  }
}
