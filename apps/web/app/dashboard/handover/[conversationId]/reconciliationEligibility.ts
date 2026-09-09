import type { OutboundDeliveryStatus } from "@dravonix/handover";

/**
 * Whether a message's outbound status makes it eligible for the manual
 * reconciliation UI (Reconcile AI message / Confirm sent / Confirm not
 * sent). Must match reconcile_outbound_message's own guard exactly
 * (supabase/migrations/00000000000012_human_handover.sql): `if
 * v_msg.outbound_status <> 'delivery_unknown' then raise exception
 * 'invalid_status_transition'`. The RPC accepts ONLY delivery_unknown --
 * never send_failed -- because a send_failed row is a synchronous rejection
 * Meta already returned during the original request; there is nothing
 * uncertain left to reconcile, unlike delivery_unknown (a send whose
 * outcome was never confirmed at all, e.g. a network failure or an expired
 * lease). Previously this UI also showed the reconcile controls for
 * send_failed, which the RPC would then reject outright with
 * invalid_status_transition -- a dead-end affordance found investigating the
 * first real staging AI outbound failure.
 */
export function isReconcileEligible(outboundStatus: OutboundDeliveryStatus | null): boolean {
  return outboundStatus === "delivery_unknown";
}
