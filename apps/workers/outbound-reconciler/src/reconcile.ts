import type { HandoverWorkerRepository } from "@dravonix/handover";
import type { Logger } from "@dravonix/observability";

export interface ReconcileDeps {
  handoverRepo: HandoverWorkerRepository;
  logger: Logger;
}

/**
 * One reconciliation pass (Human Handover Inbox final plan section 14): calls
 * expire_stale_outbound_sends(), which atomically flips every outbound
 * message whose sending lease has expired to delivery_unknown and writes its
 * own audit_logs/notifications rows -- this function only logs the result
 * for operational visibility. Never sends or resends a WhatsApp message
 * (Postgres functions can't make HTTP calls, and this Worker holds no
 * WhatsApp provider at all).
 */
export async function runReconciliation(deps: ReconcileDeps): Promise<{ expiredCount: number }> {
  const expired = await deps.handoverRepo.expireStaleOutboundSends();

  if (expired.length > 0) {
    deps.logger.warn("Expired stale outbound sends to delivery_unknown", {
      count: expired.length,
      messageIds: expired.map((m) => m.id),
    });
  } else {
    deps.logger.debug("No stale outbound sends found");
  }

  return { expiredCount: expired.length };
}
