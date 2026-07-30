import { z } from "zod";

/**
 * Base envelope every queue job payload must carry (ADR-0003). Domain-specific
 * payload schemas extend this with `.extend({...})`.
 */
export const jobEnvelopeSchema = z.object({
  jobId: z.string().uuid(),
  companyId: z.string().uuid(),
  correlationId: z.string().min(1),
  attempt: z.number().int().min(1).default(1),
  createdAt: z.string().datetime(),
  idempotencyKey: z.string().min(1),
  payloadVersion: z.number().int().min(1),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

export interface QueueMessage<T> {
  body: T;
  attempts: number;
}

export interface QueueSender<T> {
  send(body: T): Promise<void>;
}

export interface QueueConsumerHandler<T> {
  (message: QueueMessage<T>): Promise<void>;
}

/**
 * Minimal in-memory queue used by local dev and tests so consumer logic can be
 * exercised without a live Cloudflare Queues binding. Messages that throw are
 * retried up to `maxAttempts`, then routed to `deadLetter`.
 */
export class InMemoryQueue<T> implements QueueSender<T> {
  readonly deadLetter: QueueMessage<T>[] = [];
  readonly processed: T[] = [];
  private readonly maxAttempts: number;
  private handler: QueueConsumerHandler<T> | null = null;

  constructor(options: { maxAttempts?: number } = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  setHandler(handler: QueueConsumerHandler<T>): void {
    this.handler = handler;
  }

  async send(body: T): Promise<void> {
    if (!this.handler) {
      throw new Error("InMemoryQueue.send called before setHandler");
    }
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await this.handler({ body, attempts });
        this.processed.push(body);
        return;
      } catch {
        if (attempts >= this.maxAttempts) {
          this.deadLetter.push({ body, attempts });
          return;
        }
      }
    }
  }
}
