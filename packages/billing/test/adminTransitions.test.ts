import { describe, expect, it } from "vitest";
import {
  ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS,
  adminAllowedTransitionTargets,
} from "../src/adminTransitions.js";
import {
  applySubscriptionEvent,
  subscriptionTransitions,
  type SubscriptionState,
} from "../src/stateMachine.js";

const ALL_STATES: SubscriptionState[] = [
  "onboarding",
  "trial",
  "active",
  "payment_due",
  "grace_period",
  "suspended",
  "cancel_at_period_end",
  "cancelled",
  "manually_suspended",
  "closed",
];

describe("ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS: a strict narrowing of the canonical graph", () => {
  it("has exactly one entry per canonical subscription state", () => {
    expect(Object.keys(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS).sort()).toEqual(
      [...ALL_STATES].sort(),
    );
  });

  it.each(ALL_STATES)(
    "every admin-allowed target from %s is a real edge in stateMachine.ts's own transition graph",
    (state) => {
      const canonicalTargets = new Set(Object.values(subscriptionTransitions[state]));
      for (const target of ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS[state]) {
        expect(canonicalTargets.has(target)).toBe(true);
      }
    },
  );

  it("closed has zero admin-allowed targets -- fully terminal, no exceptions", () => {
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.closed).toEqual([]);
    expect(adminAllowedTransitionTargets("closed")).toEqual([]);
  });

  it("excludes every automatic-only edge (scheduler/webhook-owned, never admin-invocable)", () => {
    // trial_ended_without_payment / payment_failed -> payment_due
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.trial).not.toContain("payment_due");
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.active).not.toContain("payment_due");
    // grace_period_started
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.payment_due).not.toContain("grace_period");
    // grace_period_expired
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.grace_period).not.toContain("suspended");
    // period_ended_after_cancellation -- owned by
    // finalize_scheduled_subscription_cancellations (migration 32), not the
    // admin RPC
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.cancel_at_period_end).not.toContain("cancelled");
  });

  it("includes every transition the Phase 7B review requires admin access to", () => {
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.active).toContain("cancel_at_period_end"); // schedule cancellation
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.cancel_at_period_end).toContain("active"); // reverse
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.active).toContain("cancelled"); // immediate cancel
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.active).toContain("manually_suspended"); // manual suspend
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.manually_suspended).toContain("active"); // reactivate
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.suspended).toContain("active"); // reactivate
  });

  it("excludes every edge the Phase 7B independent-review correction pass found unsafe for manual admin control, even though each remains a real edge in the canonical graph", () => {
    // payment_recovered -- would let an admin fabricate a payment recovery
    // with zero invoice/payment verification; stays exclusively owned by
    // reconcile_razorpay_payment.
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.payment_due).not.toContain("active");
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.grace_period).not.toContain("active");
    // win-back -- current_period_start/end would go stale with no defined
    // refresh semantic.
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.cancelled).not.toContain("active");
    // force-activation -- current_period_start/end may never have been
    // established, producing a subscription generate_due_subscription_invoices
    // can never bill.
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.onboarding).not.toContain("active");
    expect(ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS.trial).not.toContain("active");
    // each of the five is still a legitimate edge canonically -- this is a
    // narrowing of admin authority, not a change to the state machine.
    for (const [from, to] of [
      ["payment_due", "active"],
      ["grace_period", "active"],
      ["cancelled", "active"],
      ["onboarding", "active"],
      ["trial", "active"],
    ] as const) {
      expect(Object.values(subscriptionTransitions[from])).toContain(to);
    }
  });

  it("every admin-allowed edge is reachable via applySubscriptionEvent without throwing", () => {
    for (const from of ALL_STATES) {
      for (const to of ADMIN_ALLOWED_SUBSCRIPTION_TRANSITIONS[from]) {
        const event = Object.entries(subscriptionTransitions[from]).find(([, s]) => s === to)?.[0];
        expect(event).toBeDefined();
        expect(applySubscriptionEvent(from, event as never)).toBe(to);
      }
    }
  });
});
