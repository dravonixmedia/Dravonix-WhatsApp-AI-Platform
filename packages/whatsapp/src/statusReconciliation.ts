export type MessageDeliveryStatus = "sent" | "delivered" | "read" | "failed";

const STATUS_RANK: Record<Exclude<MessageDeliveryStatus, "failed">, number> = {
  sent: 0,
  delivered: 1,
  read: 2,
};

/**
 * Derives the effective current status for a message from the full set of
 * status events received so far (not just the latest to arrive), so an
 * out-of-order webhook delivery (e.g. "read" arriving before "delivered") never
 * regresses the displayed status -- see ADR-0002. A "failed" event always wins,
 * since delivery cannot succeed after a provider-reported failure.
 */
export function deriveEffectiveStatus(
  events: readonly MessageDeliveryStatus[],
): MessageDeliveryStatus | null {
  if (events.length === 0) return null;
  if (events.includes("failed")) return "failed";

  let best: Exclude<MessageDeliveryStatus, "failed"> = "sent";
  for (const event of events) {
    if (event === "failed") continue;
    if (STATUS_RANK[event] > STATUS_RANK[best]) {
      best = event;
    }
  }
  return best;
}
