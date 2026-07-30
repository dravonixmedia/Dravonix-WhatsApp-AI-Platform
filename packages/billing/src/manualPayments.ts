import { ManualPaymentApprovalDeniedError } from "@dravonix/core";

/** Mirrors packages/database's PlatformRole without creating a hard dependency. */
export type ApproverPlatformRole =
  "super_admin" | "platform_support" | "platform_billing_admin" | null;

/**
 * Manual payments (bank transfer/UPI) drive the same internal subscription state
 * machine as Razorpay, via the "payment_recovered" event, once approved (Master
 * Prompt section 25). This guard enforces the two hard rules: only a
 * platform_billing_admin or super_admin may approve, and a company user may
 * never approve their own submission (the latter is structurally impossible
 * today since company users have no platform role at all, but the check is
 * explicit so it stays true if that ever changes).
 */
export function assertMayApproveManualPayment(input: {
  approverPlatformRole: ApproverPlatformRole;
  submittedByUserId: string | null;
  approverUserId: string;
}): void {
  if (
    input.approverPlatformRole !== "super_admin" &&
    input.approverPlatformRole !== "platform_billing_admin"
  ) {
    throw new ManualPaymentApprovalDeniedError(
      "Only a platform billing administrator or super admin may approve a manual payment",
    );
  }
  if (input.submittedByUserId && input.submittedByUserId === input.approverUserId) {
    throw new ManualPaymentApprovalDeniedError(
      "A user may not approve their own payment submission",
    );
  }
}
