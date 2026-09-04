import { assertCompanyMayUseProvider, type EntitlementRepository } from "@dravonix/billing";
import {
  canSendFreeFormWhatsAppMessage,
  WhatsAppProviderError,
  type WhatsAppProvider,
} from "@dravonix/whatsapp";
import {
  NoServiceWindowFallbackTemplateError,
  WhatsAppServiceWindowClosedError,
} from "./errors.js";
import type { HandoverRepository, HandoverWorkerRepository } from "./repository.js";
import type { MessageChannelType, OutboundDeliveryStatus, ServiceWindowState } from "./types.js";

export interface SendFailureClassification {
  status: "send_failed" | "delivery_unknown";
  retryable: boolean | null;
  errorCode: string | null;
}

/** No fallback template is configured for this WABA -- see admin_set_service_window_fallback_template (migration 36). */
export const NO_FALLBACK_TEMPLATE_ERROR_CODE = "whatsapp_service_window_no_fallback_template";
/** The configured fallback template exists but is no longer approved -- see whatsapp_templates.status. */
export const FALLBACK_TEMPLATE_NOT_APPROVED_ERROR_CODE =
  "whatsapp_service_window_fallback_template_not_approved";

/**
 * Classifies a failed WhatsApp send (final plan section 14; extended for
 * Meta/WhatsApp Batch 2 Phase 9 with `errorSubcode`). A definitive rejection
 * from Meta (a WhatsAppProviderError -- we know the HTTP response) is
 * `send_failed`, retryable only for transient conditions (429/5xx).
 * Anything else -- a network failure, timeout, or any error that isn't a
 * clean provider rejection -- means we genuinely don't know whether Meta
 * received and accepted the request, so it must be `delivery_unknown`
 * (never auto-resent) rather than guessed as failed.
 *
 * `errorCode` is always derived structurally from Meta's own `error.code` /
 * `error.error_subcode` fields (formatted "code/subcode" when a subcode is
 * present) -- never by matching any part of Meta's English error message.
 * This applies equally to a rejection of a free-form send outside the
 * window (Meta's own authoritative check, independent of and a defense in
 * depth against canSendFreeFormWhatsAppMessage's local, preventative one)
 * and to a rejection of the template-fallback send itself.
 */
export function classifySendError(error: unknown): SendFailureClassification {
  if (error instanceof WhatsAppProviderError) {
    const retryable = error.status === 429 || error.status >= 500;
    const errorCode = error.errorCode ?? String(error.status);
    return {
      status: "send_failed",
      retryable,
      errorCode: error.errorSubcode ? `${errorCode}/${error.errorSubcode}` : errorCode,
    };
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
 *
 * Meta/WhatsApp Batch 2, Phase 8: a human agent's ordinary free-form reply
 * is blocked outright once the 24-hour WhatsApp customer service window has
 * closed -- WhatsAppServiceWindowClosedError is thrown before any
 * reservation is even created, so nothing is ever falsely marked as sent.
 * Unlike the AI paths below, this never auto-substitutes the configured
 * fallback template: a human decides that explicitly, via
 * sendServiceWindowReengagementTemplate.
 */
export async function sendHumanReply(
  repo: HandoverRepository,
  whatsappProvider: WhatsAppProvider,
  entitlementRepo: EntitlementRepository,
  input: SendHumanReplyInput,
): Promise<SendOutboundResult> {
  await assertCompanyMayUseProvider(entitlementRepo, input.companyId, "whatsapp_send");

  const lastCustomerMessageAt = await repo.getLastCustomerMessageAt(input.conversationId);
  if (!canSendFreeFormWhatsAppMessage(lastCustomerMessageAt, new Date())) {
    throw new WhatsAppServiceWindowClosedError(input.conversationId);
  }

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

export interface SendServiceWindowTemplateInput {
  conversationId: string;
  idempotencyKey: string;
  phoneNumberId: string;
  toWaId: string;
}

/**
 * Meta/WhatsApp Batch 2, Phase 8: an assigned/authorized human agent
 * deliberately sends the conversation's configured re-engagement template
 * once the free-form window has closed. Never accepts a template id/name
 * from the caller -- reserveHumanTemplateOutboundMessage (migration 36)
 * resolves and validates the ONE account-configured, currently-approved
 * fallback itself and returns its name/language, so the browser can never
 * choose an arbitrary template. Reuses finalizeHumanOutboundMessage
 * (migration 12, unchanged) exactly like any other human-authored outbound
 * message. If no fallback is configured/approved, the RPC itself raises
 * `no_fallback_template_configured` -- translated here into
 * NoServiceWindowFallbackTemplateError (a typed, safe-to-display domain
 * error) rather than left as the RPC's bare error string, so the caller can
 * show a clear, specific message rather than a silent no-op or a leaked
 * internal exception.
 */
export async function sendServiceWindowReengagementTemplate(
  repo: HandoverRepository,
  whatsappProvider: WhatsAppProvider,
  input: SendServiceWindowTemplateInput,
): Promise<SendOutboundResult> {
  let reservation;
  try {
    reservation = await repo.reserveHumanTemplateOutboundMessage(
      input.conversationId,
      input.idempotencyKey,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "no_fallback_template_configured") {
      throw new NoServiceWindowFallbackTemplateError(input.conversationId);
    }
    throw error;
  }
  if (!reservation.claimed) {
    return {
      messageId: reservation.id,
      outboundStatus: reservation.outboundStatus,
      alreadyHandled: true,
    };
  }

  try {
    const sendResult = await whatsappProvider.sendTemplate({
      phoneNumberId: input.phoneNumberId,
      toWaId: input.toWaId,
      templateName: reservation.templateName,
      languageCode: reservation.templateLanguage,
      bodyParameters: [],
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
 * Meta/WhatsApp Batch 2, Phase 2/7: resolves whether the 24-hour free-form
 * service window is currently open for the conversation this inbound
 * message belongs to, plus its WABA's configured fallback template (if
 * any). Exported separately from sendAiOutboundMessage so a caller that
 * needs to skip *other* expensive work before even attempting a send --
 * apps/workers/voice-consumer skips text-to-speech synthesis entirely for a
 * closed window (Phase 7) -- can check this once, up front, rather than
 * only at the final send call.
 */
export async function resolveServiceWindowState(
  repo: HandoverWorkerRepository,
  sourceMessageId: string,
): Promise<ServiceWindowState & { open: boolean }> {
  const state = await repo.getServiceWindowState(sourceMessageId);
  return {
    ...state,
    open: canSendFreeFormWhatsAppMessage(state.lastCustomerMessageAt, new Date()),
  };
}

/**
 * Meta/WhatsApp Batch 2, Phase 6/7: the sole outbound artifact for one
 * inbound message once the free-form window has closed, regardless of
 * which reply channel(s) (text, audio, or both for a voice job's
 * text_and_voice mode) originally wanted to reply. Always reserves under
 * channel_type = 'template', keyed by the SAME source_message_id every
 * other channel-specific reservation for this inbound message would use --
 * reusing reserve_ai_outbound_message's existing partial unique index
 * (migration 12, unmodified) so this is naturally idempotent both against a
 * queue redelivery of the *same* attempt AND against a second reply channel
 * for the same inbound message racing this one: whichever caller reserves
 * first wins, and every other caller (any channel, any retry) sees
 * `claimed: false` and does nothing further -- exactly one template is ever
 * sent per inbound message.
 *
 * Never attempts a WhatsApp call at all when no fallback template is
 * configured/approved -- fails safely and visibly instead (outbound_status
 * = send_failed, last_send_error_code = NO_FALLBACK_TEMPLATE_ERROR_CODE),
 * never pretending the AI's original free-form response was delivered.
 */
export async function sendServiceWindowFallback(
  repo: HandoverWorkerRepository,
  whatsappProvider: WhatsAppProvider,
  input: {
    sourceMessageId: string;
    phoneNumberId: string;
    toWaId: string;
    fallbackTemplate: ServiceWindowState["fallbackTemplate"];
  },
): Promise<SendOutboundResult> {
  const reservation = await repo.reserveAiOutboundMessage(input.sourceMessageId, "template");
  if (!reservation.claimed) {
    return {
      messageId: reservation.id,
      outboundStatus: reservation.outboundStatus,
      alreadyHandled: true,
    };
  }

  if (!input.fallbackTemplate) {
    const finalized = await repo.finalizeAiOutboundMessage(
      reservation.id,
      "send_failed",
      null,
      null,
      NO_FALLBACK_TEMPLATE_ERROR_CODE,
      false,
    );
    return {
      messageId: finalized.id,
      outboundStatus: finalized.outboundStatus,
      alreadyHandled: false,
    };
  }

  try {
    const sendResult = await whatsappProvider.sendTemplate({
      phoneNumberId: input.phoneNumberId,
      toWaId: input.toWaId,
      templateName: input.fallbackTemplate.name,
      languageCode: input.fallbackTemplate.language,
      bodyParameters: [],
    });
    const finalized = await repo.finalizeAiOutboundMessage(
      reservation.id,
      "sent",
      sendResult.providerMessageId,
      null,
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

/**
 * AI-reply reserve -> send -> finalize lifecycle (final plan section 12),
 * used by apps/workers/message-consumer and voice-consumer in place of a
 * direct WhatsApp send + best-effort record. `claimed: false` means this
 * exact inbound message already produced a reply on this channel (a
 * redelivered queue message, or a retry after a prior success) -- the
 * caller must skip the WhatsApp call entirely in that case.
 *
 * Meta/WhatsApp Batch 2, Phase 6: checks the 24-hour free-form service
 * window FIRST. Outside the window, `input.channelType` is ignored entirely
 * and the reply is redirected to sendServiceWindowFallback instead -- the
 * AI's free-form response (already generated, already used for lead
 * updates/handover decisions upstream) is simply never sent as free-form
 * text/audio.
 */
export async function sendAiOutboundMessage(
  repo: HandoverWorkerRepository,
  whatsappProvider: WhatsAppProvider,
  input: SendAiOutboundMessageInput,
): Promise<SendOutboundResult> {
  const serviceWindow = await resolveServiceWindowState(repo, input.sourceMessageId);
  if (!serviceWindow.open) {
    return sendServiceWindowFallback(repo, whatsappProvider, {
      sourceMessageId: input.sourceMessageId,
      phoneNumberId: input.phoneNumberId,
      toWaId: input.toWaId,
      fallbackTemplate: serviceWindow.fallbackTemplate,
    });
  }

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
