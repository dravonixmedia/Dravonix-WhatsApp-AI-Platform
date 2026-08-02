import type { Logger } from "./logger.js";

export type HandoverTriggerSource =
  "claude" | "validation_fallback" | "voice_failure" | "explicit_customer_request";

/**
 * Everything required to explain *why* a triggerHandover call is about to
 * happen, and nothing else. Deliberately excludes message bodies, phone
 * numbers, contact names, and credentials -- a handover decision must be
 * auditable without ever becoming a place personal data or secrets leak into
 * logs (values still pass through redactSecrets as an additional backstop).
 */
export interface HandoverTriggerLogFields {
  conversationId: string;
  /** The inbound message that is about to cause this handover. */
  messageId: string;
  reasonCode: string;
  source: HandoverTriggerSource;
  /** Number of AI generation attempts made this turn (1, or 2 if a repair attempt was needed). */
  validationAttemptCount: number;
  previousState: string;
}

/**
 * Logs a structured, PII-free record immediately before every triggerHandover
 * call, so the exact trigger (Claude decision, validation fallback, a voice
 * failure, or an explicit customer request) is always reconstructible from
 * logs alone.
 */
export function logHandoverTrigger(logger: Logger, fields: HandoverTriggerLogFields): void {
  logger.warn("Triggering handover: conversation will stop receiving automatic AI replies", {
    ...fields,
  });
}
