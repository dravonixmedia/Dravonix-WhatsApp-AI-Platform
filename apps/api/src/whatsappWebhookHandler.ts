import type { QueueSender } from "@dravonix/core";
import type { Logger } from "@dravonix/observability";
import {
  parseWhatsAppWebhookPayload,
  routePhoneNumberId,
  verifyMetaWebhookChallenge,
  verifyMetaWebhookSignature,
  type WhatsAppWebhookEvent,
} from "@dravonix/whatsapp";
import type { MessageJobPayload, VoiceJobPayload } from "./queuePayloads.js";
import type { WhatsAppIngestRepository } from "./repositories/whatsappIngestRepository.js";

export interface WhatsAppWebhookDeps {
  appSecret: string;
  verifyToken: string;
  repo: WhatsAppIngestRepository;
  // Optional: absent until the underlying queues exist and their bindings are
  // uncommented in wrangler.toml (see CLOUDFLARE_SETUP.md). When absent, the
  // webhook still verifies signatures, dedupes, and persists messages -- it
  // just can't hand them off for AI/voice processing yet, which is logged
  // rather than crashing the whole webhook endpoint.
  messageQueue: QueueSender<MessageJobPayload> | undefined;
  voiceQueue: QueueSender<VoiceJobPayload> | undefined;
  logger: Logger;
}

export interface HttpResult {
  status: number;
  body: string;
}

/** GET /webhooks/whatsapp -- Meta's verification handshake (ADR-0002). */
export function handleWhatsAppWebhookVerification(
  deps: Pick<WhatsAppWebhookDeps, "verifyToken">,
  query: { mode: string | null; verifyToken: string | null; challenge: string | null },
): HttpResult {
  const challenge = verifyMetaWebhookChallenge(query, deps.verifyToken);
  if (challenge === null) {
    return { status: 403, body: "verification failed" };
  }
  return { status: 200, body: challenge };
}

function webhookEventIdempotencyKey(event: WhatsAppWebhookEvent): string {
  if (event.kind === "status_update") {
    return `status:${event.providerMessageId}:${event.status}:${event.timestamp}`;
  }
  return `message:${event.providerMessageId}`;
}

async function handleSingleEvent(
  deps: WhatsAppWebhookDeps,
  event: WhatsAppWebhookEvent,
): Promise<void> {
  const idempotencyKey = webhookEventIdempotencyKey(event);

  if (await deps.repo.isDuplicateWebhookEvent(idempotencyKey)) {
    deps.logger.info("Skipping duplicate WhatsApp webhook event", { idempotencyKey });
    return;
  }

  const routing = await routePhoneNumberId(deps.repo, event.phoneNumberId);
  if (!routing.routed || !routing.companyId) {
    await deps.repo.recordWebhookEvent({
      providerEventId: idempotencyKey,
      companyId: null,
      status: "unrouted",
      rawPayload: event,
    });
    deps.logger.warn("Unrouted WhatsApp webhook event: unknown phone_number_id", {
      phoneNumberId: event.phoneNumberId,
    });
    return;
  }
  const companyId = routing.companyId;

  if (event.kind === "status_update") {
    await deps.repo.recordMessageStatusEvent({
      providerMessageId: event.providerMessageId,
      status: event.status,
      failureReason: event.failureReason,
    });
    await deps.repo.recordWebhookEvent({
      providerEventId: idempotencyKey,
      companyId,
      status: "processed",
      rawPayload: event,
    });
    return;
  }

  if (event.kind === "inbound_unsupported") {
    await deps.repo.recordWebhookEvent({
      providerEventId: idempotencyKey,
      companyId,
      status: "processed",
      rawPayload: event,
    });
    return;
  }

  if (await deps.repo.isDuplicateMessage(event.providerMessageId)) {
    await deps.repo.recordWebhookEvent({
      providerEventId: idempotencyKey,
      companyId,
      status: "duplicate",
      rawPayload: event,
    });
    return;
  }

  const { conversationId } = await deps.repo.upsertContactAndConversation({
    companyId,
    waId: event.waId,
    profileName: event.profileName,
    phoneNumberId: event.phoneNumberId,
  });

  const baseJobFields = {
    jobId: crypto.randomUUID(),
    companyId,
    correlationId: crypto.randomUUID(),
    attempt: 1,
    createdAt: new Date().toISOString(),
    idempotencyKey: event.providerMessageId,
    payloadVersion: 1,
  };

  if (event.kind === "inbound_text") {
    const { messageId } = await deps.repo.recordInboundMessage({
      companyId,
      conversationId,
      providerMessageId: event.providerMessageId,
      body: event.body,
      channelType: "text",
    });

    if (deps.messageQueue) {
      const payload: MessageJobPayload = {
        ...baseJobFields,
        kind: "inbound_text",
        conversationId,
        messageId,
        waId: event.waId,
        body: event.body,
      };
      await deps.messageQueue.send(payload);
    } else {
      deps.logger.warn("Message persisted but not enqueued: MESSAGE_QUEUE is not configured yet", {
        messageId,
      });
    }
  } else if (event.kind === "inbound_audio") {
    const { messageId } = await deps.repo.recordInboundMessage({
      companyId,
      conversationId,
      providerMessageId: event.providerMessageId,
      body: null,
      channelType: "audio",
    });

    if (deps.voiceQueue) {
      const payload: VoiceJobPayload = {
        ...baseJobFields,
        kind: "inbound_audio",
        conversationId,
        messageId,
        waId: event.waId,
        mediaId: event.mediaId,
        mimeType: event.mimeType,
      };
      await deps.voiceQueue.send(payload);
    } else {
      deps.logger.warn(
        "Audio message persisted but not enqueued: VOICE_QUEUE is not configured yet",
        { messageId },
      );
    }
  }

  await deps.repo.recordWebhookEvent({
    providerEventId: idempotencyKey,
    companyId,
    status: "processed",
    rawPayload: event,
  });
}

/**
 * POST /webhooks/whatsapp. Verifies the signature over the raw body first,
 * then does the minimum synchronous work before returning 200 (ADR-0002):
 * parse -> route -> dedupe -> persist -> enqueue. Never throws for malformed
 * payload content (a verified-but-malformed payload is logged and acked, not
 * crashed on) -- only an invalid signature is rejected.
 */
export async function handleWhatsAppWebhookPost(
  deps: WhatsAppWebhookDeps,
  rawBody: string,
  signatureHeader: string | null,
): Promise<HttpResult> {
  const validSignature = await verifyMetaWebhookSignature(rawBody, signatureHeader, deps.appSecret);
  if (!validSignature) {
    deps.logger.warn("Rejected WhatsApp webhook: invalid signature");
    return { status: 401, body: "invalid signature" };
  }

  let events: WhatsAppWebhookEvent[];
  try {
    events = parseWhatsAppWebhookPayload(JSON.parse(rawBody));
  } catch (error) {
    deps.logger.error("Failed to parse WhatsApp webhook payload", { error: String(error) });
    return { status: 200, body: "ok" };
  }

  for (const event of events) {
    await handleSingleEvent(deps, event);
  }

  return { status: 200, body: "ok" };
}
