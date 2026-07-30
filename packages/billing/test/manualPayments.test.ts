import { ManualPaymentApprovalDeniedError } from "@dravonix/core";
import { describe, expect, it } from "vitest";
import { assertMayApproveManualPayment } from "../src/manualPayments.js";

describe("assertMayApproveManualPayment", () => {
  it("allows a platform_billing_admin to approve someone else's submission", () => {
    expect(() =>
      assertMayApproveManualPayment({
        approverPlatformRole: "platform_billing_admin",
        submittedByUserId: "company-user-1",
        approverUserId: "billing-admin-1",
      }),
    ).not.toThrow();
  });

  it("allows a super_admin to approve", () => {
    expect(() =>
      assertMayApproveManualPayment({
        approverPlatformRole: "super_admin",
        submittedByUserId: "company-user-1",
        approverUserId: "super-admin-1",
      }),
    ).not.toThrow();
  });

  it("rejects a non-billing platform role", () => {
    expect(() =>
      assertMayApproveManualPayment({
        approverPlatformRole: "platform_support",
        submittedByUserId: "company-user-1",
        approverUserId: "support-1",
      }),
    ).toThrow(ManualPaymentApprovalDeniedError);
  });

  it("rejects a company user with no platform role at all", () => {
    expect(() =>
      assertMayApproveManualPayment({
        approverPlatformRole: null,
        submittedByUserId: "company-user-1",
        approverUserId: "company-user-2",
      }),
    ).toThrow(ManualPaymentApprovalDeniedError);
  });

  it("rejects a user approving their own submission even if otherwise authorized", () => {
    expect(() =>
      assertMayApproveManualPayment({
        approverPlatformRole: "platform_billing_admin",
        submittedByUserId: "billing-admin-1",
        approverUserId: "billing-admin-1",
      }),
    ).toThrow(ManualPaymentApprovalDeniedError);
  });
});
