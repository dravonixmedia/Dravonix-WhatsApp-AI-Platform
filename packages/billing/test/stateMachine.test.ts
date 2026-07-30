import { InvalidStateTransitionError } from "@dravonix/core";
import { describe, expect, it } from "vitest";
import { applySubscriptionEvent, isServiceBlocked } from "../src/stateMachine.js";

describe("subscription state machine", () => {
  it("walks the normal onboarding -> trial -> active -> renewal path", () => {
    expect(applySubscriptionEvent("onboarding", "start_trial")).toBe("trial");
    expect(applySubscriptionEvent("trial", "activate")).toBe("active");
    expect(applySubscriptionEvent("active", "payment_recovered")).toBe("active");
  });

  it("walks the payment-failure -> grace period -> suspension path", () => {
    expect(applySubscriptionEvent("active", "payment_failed")).toBe("payment_due");
    expect(applySubscriptionEvent("payment_due", "grace_period_started")).toBe("grace_period");
    expect(applySubscriptionEvent("grace_period", "grace_period_expired")).toBe("suspended");
  });

  it("reactivates a suspended company once payment is verified", () => {
    expect(applySubscriptionEvent("suspended", "payment_recovered")).toBe("active");
  });

  it("recovers from grace_period directly back to active", () => {
    expect(applySubscriptionEvent("grace_period", "payment_recovered")).toBe("active");
  });

  it("supports manual suspension and reactivation from any operational state", () => {
    expect(applySubscriptionEvent("active", "manual_suspend")).toBe("manually_suspended");
    expect(applySubscriptionEvent("manually_suspended", "manual_reactivate")).toBe("active");
  });

  it("supports cancel-at-period-end and its reversal", () => {
    expect(applySubscriptionEvent("active", "cancel_at_period_end_requested")).toBe(
      "cancel_at_period_end",
    );
    expect(applySubscriptionEvent("cancel_at_period_end", "cancel_at_period_end_reversed")).toBe(
      "active",
    );
    expect(applySubscriptionEvent("cancel_at_period_end", "period_ended_after_cancellation")).toBe(
      "cancelled",
    );
  });

  it("rejects an invalid transition instead of silently coercing state", () => {
    expect(() => applySubscriptionEvent("closed", "activate")).toThrow(InvalidStateTransitionError);
  });

  it("rejects suspending an already-closed subscription", () => {
    expect(() => applySubscriptionEvent("closed", "manual_suspend")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("rejects a grace_period_expired event from a state with no grace period", () => {
    expect(() => applySubscriptionEvent("active", "grace_period_expired")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("flags suspended, manually_suspended, cancelled, and closed as service-blocked", () => {
    expect(isServiceBlocked("suspended")).toBe(true);
    expect(isServiceBlocked("manually_suspended")).toBe(true);
    expect(isServiceBlocked("cancelled")).toBe(true);
    expect(isServiceBlocked("closed")).toBe(true);
  });

  it("does not flag active, trial, payment_due, or grace_period as service-blocked", () => {
    expect(isServiceBlocked("active")).toBe(false);
    expect(isServiceBlocked("trial")).toBe(false);
    expect(isServiceBlocked("payment_due")).toBe(false);
    expect(isServiceBlocked("grace_period")).toBe(false);
  });
});
