import { assertCompanyMayUseProvider, type EntitlementRepository } from "@dravonix/billing";
import { WhatsAppProviderError, type WhatsAppProvider } from "@dravonix/whatsapp";
import type { HandoverRepository, HandoverWorkerRepository } from "./repository.js";
import type { MessageChannelType, OutboundDeliveryStatus } from "./types.js";

export interface SendFailureClassification {
  status: "send_failed" | "delivery_unknown";
  retryable: boolean | null;
  errorCode: string | null;
}

/**
 * Classifies a failed WhatsApp send (final plan section 14). A definitive
 * rejection from Meta (a WhatsAppProviderError -- we know the HTTP response)
 * is `send_failed`, retryable only for transient conditions (429/5xx).
 * Anything else -- a network failure, timeout, or any error that isn't a
 * clean provider rejection -- means we genuinely don't know whether Meta
 * received and accepted the request, so it must be `delivery_unknown`
 * (never auto-resent) rather than guessed as failed.
 */
export function classifySendError(error: unknown): SendFailureClassification {
  if (error instanceof WhatsAppProviderError) {
    const retryable = error.status === 429 || error.status >= 500;
    return { status: "send_failed", retryable, errorCode: error.errorCode ?? String(error.status) };
  }
  return { status: "delivery_unknown", retryable: null, errorCode: null };
}

export interface SendHumanReplyInput {
  companyId: string;
  conversationId: string;
  body: string;
  idempotencyKey: string;
  phoneNumberId: string;
  toWaId: string;
}

export interface SendOutboundResult {
  messageId: string;
  outboundStatus: OutboundDeliveryStatus;
  /** True if this call didn't need to (re-)attempt a WhatsApp send at all -- already handled by a prior call. */
  alreadyHandled: boolean;
}

/**
 * Human-reply reserve -> send -> finalize lifecycle (final plan section 11).
 * Entitlement is checked before reserving so a blocked company never leaves
 * behind an orphaned "sending" reservation with no send attempt behind it.
 */
export async function sendHumanReply(
  repo: HandoverRepository,
  whatsappProvider: WhatsAppProvider,
  entitlementRepo: EntitlementRepository,
  input: SendHumanReplyInput,
): Promise<SendOutboundResult> {
  await assertCompanyMayUseProvider(entitlementRepo, input.companyId, "whatsapp_send");

  const reservation = await repo.reserveHumanOutboundMessage(
    input.conversationId,
    input.body,
    input.idempotencyKey,
  );
  if (!reservation.claimed) {
    return {
      messageId: reservation.id,
      outboundStatus: reservation.outboundStatus,
      alreadyHandled: true,
    };
  }

  try {
    const sendResult = await whatsappProvider.sendText({
      phoneNumberId: input.phoneNumberId,
      toWaId: input.toWaId,
      body: input.body,
    });
    const finalized = await repo.finalizeHumanOutboundMessage(
      reservation.id,
      "sent",
      sendResult.providerMessageId,
    );
    return {
      messageId: finalized.id,
      outboundStatus: finalized.outboundStatus,
      alreadyHandled: false,
    };
  } catch (error) {
    const classification = classifySendError(error);
    const finalized = await repo.finalizeHumanOutboundMessage(
      reservation.id,
      classification.status,
      null,
      classification.errorCode,
      classification.retryable,
    );
    return {
      messageId: finalized.id,
      outboundStatus: finalized.outboundStatus,
      alreadyHandled: false,
    };
  }
}

export interface SendAiOutboundMessageInput {
  sourceMessageId: string;
  channelType: MessageChannelType;
  phoneNumberId: string;
  toWaId: string;
  /** Required when channelType === "text". */
  body?: string;
  /** Required when channelType === "audio". */
  audioMediaIdOrUrl?: string;
}

/**
 * AI-reply reserve -> send -> finalize lifecycle (final plan section 12),
 * used by apps/workers/message-consumer and voice-consumer in place of a
 * direct WhatsApp send + best-effort record. `claimed: false` means this
 * exact inbound message already produced a reply on this channel (a
 * redelivered queue message, or a retry after a prior success) -- the
 * caller must skip the WhatsApp call entirely in that case.
 */
export async function sendAiOutboundMessage(
  repo: HandoverWorkerRepository,
  whatsappProvider: WhatsAppProvider,
  input: SendAiOutboundMessageInput,
): Promise<SendOutboundResult> {
  const reservation = await repo.reserveAiOutboundMessage(input.sourceMessageId, input.channelType);
  if (!reservation.claimed) {
    return {
      messageId: reservation.id,
      outboundStatus: reservation.outboundStatus,
      alreadyHandled: true,
    };
  }

  try {
    const sendResult =
      input.channelType === "audio"
        ? await whatsappProvider.sendAudio({
            phoneNumberId: input.phoneNumberId,
            toWaId: input.toWaId,
            audioMediaIdOrUrl: input.audioMediaIdOrUrl ?? "",
          })
        : await whatsappProvider.sendText({
            phoneNumberId: input.phoneNumberId,
            toWaId: input.toWaId,
            body: input.body ?? "",
          });
    const finalized = await repo.finalizeAiOutboundMessage(
      reservation.id,
      "sent",
      sendResult.providerMessageId,
      input.body ?? null,
    );
    return {
      messageId: finalized.id,
      outboundStatus: finalized.outboundStatus,
      alreadyHandled: false,
    };
  } catch (error) {
    const classification = classifySendError(error);
    const finalized = await repo.finalizeAiOutboundMessage(
      reservation.id,
      classification.status,
      null,
      null,
      classification.errorCode,
      classification.retryable,
    );
    return {
      messageId: finalized.id,
      outboundStatus: finalized.outboundStatus,
      alreadyHandled: false,
    };
  }
}
