/**
 * Meta's WhatsApp Cloud API customer service window (Meta/WhatsApp Batch 2):
 * a business may send a free-form (non-template) message only within 24
 * hours of the customer's own most recent message in a conversation. After
 * that, Meta rejects a free-form send outright -- only an approved template
 * message may be sent until the customer messages again.
 *
 * This is the ONE place this 24-hour rule is computed. Every send path
 * (AI text, AI voice, human handover) calls this same function against a
 * repository-resolved "most recent qualifying inbound customer message"
 * timestamp -- never its own independent calculation.
 */
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The boundary is treated as CLOSED once 24 hours have fully elapsed (a
 * strict less-than check, never <=): Meta's own server clock, not ours, is
 * authoritative, and clock skew or network/processing latency between this
 * local check and the moment the request actually reaches Meta could
 * otherwise let a locally-"open" window arrive already closed. Because of
 * that, a local "open" verdict here is only ever a pre-flight optimization
 * to avoid an API call we already know is doomed -- Meta may still reject a
 * send this check allowed, and that rejection is always authoritative (see
 * classifySendError's defense-in-depth handling in
 * @dravonix/handover/outboundMessage.ts). `lastCustomerMessageAt === null`
 * (no qualifying inbound message has ever been recorded for this
 * conversation) always means the window is closed -- there is nothing to
 * measure 24 hours from.
 */
export function canSendFreeFormWhatsAppMessage(
  lastCustomerMessageAt: string | Date | null,
  now: Date,
): boolean {
  if (lastCustomerMessageAt === null) return false;
  const lastAt =
    lastCustomerMessageAt instanceof Date ? lastCustomerMessageAt : new Date(lastCustomerMessageAt);
  const elapsedMs = now.getTime() - lastAt.getTime();
  return elapsedMs < WHATSAPP_SERVICE_WINDOW_MS;
}
