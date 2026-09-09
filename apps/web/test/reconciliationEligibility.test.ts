import { describe, expect, it } from "vitest";
import { isReconcileEligible } from "../app/dashboard/handover/[conversationId]/reconciliationEligibility.js";

/**
 * Regression coverage for the confirmed ConversationThread.tsx mismatch
 * found investigating the first real staging AI outbound failure:
 * reconcile_outbound_message (migration 12) only permits the
 * delivery_unknown -> {sent, send_failed} transition -- a message already
 * in send_failed makes the RPC raise invalid_status_transition. The
 * dashboard's eligibility check must match that guard exactly, never show a
 * reconcile affordance the RPC will reject outright.
 */
describe("isReconcileEligible", () => {
  it("delivery_unknown is eligible for reconciliation", () => {
    expect(isReconcileEligible("delivery_unknown")).toBe(true);
  });

  it("send_failed is NOT eligible -- the RPC only accepts delivery_unknown", () => {
    expect(isReconcileEligible("send_failed")).toBe(false);
  });

  it("sent is not eligible", () => {
    expect(isReconcileEligible("sent")).toBe(false);
  });

  it("sending is not eligible", () => {
    expect(isReconcileEligible("sending")).toBe(false);
  });

  it("reserved is not eligible", () => {
    expect(isReconcileEligible("reserved")).toBe(false);
  });

  it("null is not eligible (inbound/customer messages have no outbound status)", () => {
    expect(isReconcileEligible(null)).toBe(false);
  });
});
