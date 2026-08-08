import { createLogger } from "@dravonix/observability";
import { describe, expect, it, vi } from "vitest";
import { handleVoiceDlqBatch, type DlqBatch } from "../src/handleDlqBatch.js";
import type { VoiceJobPayload } from "../src/processVoiceJob.js";

const silentLogger = createLogger({ environment: "test" }, { write: () => {} });

function makePayload(overrides: Partial<VoiceJobPayload> = {}): VoiceJobPayload {
  return {
    companyId: "aaaaaaaa-0000-0000-0000-000000000001",
    conversationId: "conv-1",
    messageId: "msg-1",
    waId: "919820000001",
    mediaId: "MEDIA1",
    mimeType: "audio/ogg",
    jobId: "job-1",
    correlationId: "corr-1",
    attempt: 3,
    ...overrides,
  };
}

function makeBatch(payloads: VoiceJobPayload[]): { batch: DlqBatch; acked: string[] } {
  const acked: string[] = [];
  const batch: DlqBatch = {
    messages: payloads.map((body) => ({
      body,
      ack: () => acked.push(body.messageId),
    })),
  };
  return { batch, acked };
}

describe("handleVoiceDlqBatch (PHASE 9/10: triage only, never replays the business workflow)", () => {
  it("records a durable job_failure for each DLQ message and acks it", async () => {
    const recordJobFailure = vi.fn(async () => {});
    const { batch, acked } = makeBatch([makePayload()]);

    await handleVoiceDlqBatch(
      {
        repo: { recordJobFailure },
        logger: silentLogger,
        queueName: "dravonix-voice-queue-staging-dlq",
      },
      batch,
    );

    expect(recordJobFailure).toHaveBeenCalledTimes(1);
    expect(recordJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "aaaaaaaa-0000-0000-0000-000000000001",
        queueName: "dravonix-voice-queue-staging-dlq",
        jobId: "job-1",
        messageId: "msg-1",
        stage: "dead_letter_queue",
        category: "exhausted_retries",
        retryable: false,
      }),
    );
    expect(acked).toEqual(["msg-1"]);
  });

  it("processes every message in the batch independently and acks all of them", async () => {
    const recordJobFailure = vi.fn(async () => {});
    const { batch, acked } = makeBatch([
      makePayload({ messageId: "msg-1" }),
      makePayload({ messageId: "msg-2" }),
      makePayload({ messageId: "msg-3" }),
    ]);

    await handleVoiceDlqBatch(
      { repo: { recordJobFailure }, logger: silentLogger, queueName: "dravonix-voice-queue-dlq" },
      batch,
    );

    expect(recordJobFailure).toHaveBeenCalledTimes(3);
    expect(acked).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("acks the message even when recording the failure itself throws -- never blocks on bookkeeping failure and never falls back to replaying the job", async () => {
    const recordJobFailure = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const { batch, acked } = makeBatch([makePayload()]);

    await handleVoiceDlqBatch(
      {
        repo: { recordJobFailure },
        logger: silentLogger,
        queueName: "dravonix-voice-queue-staging-dlq",
      },
      batch,
    );

    expect(acked).toEqual(["msg-1"]);
  });

  it("never touches an AI provider, WhatsApp provider, or STT provider -- this handler's dependency shape structurally cannot replay the business workflow", async () => {
    // VoiceDlqDeps only accepts { repo: Pick<VoiceConsumerRepository, "recordJobFailure">, logger, queueName }
    // -- there is no aiProvider/whatsappProvider/sttProvider field to wire
    // up in the first place, so "never re-transcribes/regenerates AI/resends
    // WhatsApp" (PHASE 10) is enforced by this function's own type
    // signature, not just by convention. This test documents that
    // structural guarantee via a successful call with the minimal deps shape.
    const recordJobFailure = vi.fn(async () => {});
    const { batch } = makeBatch([makePayload()]);

    await expect(
      handleVoiceDlqBatch(
        { repo: { recordJobFailure }, logger: silentLogger, queueName: "dravonix-voice-queue-dlq" },
        batch,
      ),
    ).resolves.toBeUndefined();
  });

  it("never includes company_id from one message in another message's failure record within the same batch", async () => {
    const recordJobFailure = vi.fn(async () => {});
    const { batch } = makeBatch([
      makePayload({ companyId: "company-a", messageId: "msg-a" }),
      makePayload({ companyId: "company-b", messageId: "msg-b" }),
    ]);

    await handleVoiceDlqBatch(
      { repo: { recordJobFailure }, logger: silentLogger, queueName: "dravonix-voice-queue-dlq" },
      batch,
    );

    expect(recordJobFailure).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ companyId: "company-a", messageId: "msg-a" }),
    );
    expect(recordJobFailure).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ companyId: "company-b", messageId: "msg-b" }),
    );
  });
});
