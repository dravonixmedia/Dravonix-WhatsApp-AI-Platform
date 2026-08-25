import type { SupabaseClient } from "@supabase/supabase-js";

export interface ReconcileRazorpayPaymentInput {
  providerEventId: string;
  eventStatus: "captured" | "failed";
  razorpayOrderId: string;
  razorpayPaymentId: string;
  /** Smallest currency unit (e.g. paise for INR), exactly as Razorpay's payment entity represents it -- reconcile_razorpay_payment verifies this against the internal payment's own expected amount before ever marking it succeeded. */
  amountInSmallestUnit: number;
  currency: string;
  rawPayload: unknown;
}

/** Everything the Razorpay webhook route needs to reconcile a payment -- one method, since all the transactional logic lives in the reconcile_razorpay_payment RPC (migration 28), not here. */
export interface RazorpayPaymentRepository {
  reconcilePayment(input: ReconcileRazorpayPaymentInput): Promise<void>;
}

/**
 * Production implementation, calling the service_role-only
 * reconcile_razorpay_payment RPC (migration 28). Uses the service-role
 * client (bypasses RLS) since this runs entirely server-side in the
 * webhook route, with no end-user JWT -- same convention as
 * SupabaseWhatsAppIngestRepository. All idempotency/tenant-scoping/state-
 * transition logic is enforced inside the RPC itself, not here.
 */
export class SupabaseRazorpayPaymentRepository implements RazorpayPaymentRepository {
  constructor(private readonly client: SupabaseClient) {}

  async reconcilePayment(input: ReconcileRazorpayPaymentInput): Promise<void> {
    const { error } = await this.client.rpc("reconcile_razorpay_payment", {
      p_provider_event_id: input.providerEventId,
      p_event_status: input.eventStatus,
      p_razorpay_order_id: input.razorpayOrderId,
      p_razorpay_payment_id: input.razorpayPaymentId,
      p_amount_in_smallest_unit: input.amountInSmallestUnit,
      p_currency: input.currency,
      p_raw_payload: input.rawPayload,
    });
    if (error) throw error;
  }
}
