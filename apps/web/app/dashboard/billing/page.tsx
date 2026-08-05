import { redirect } from "next/navigation";

/**
 * No client-ready billing/subscription system exists yet: this page used to
 * render a fabricated "Starter (trial) — demo tenant" plan with no real data
 * behind it. The full subscription system (plans, Razorpay, invoices,
 * upgrades/downgrades, usage metering) is deferred to a separate branch
 * (claude/subscriptions-team-management); until then, the honest
 * "not configured" subscription status lives in Settings. Removed from the
 * sidebar nav; this route redirects rather than showing a developer
 * placeholder in case anything still links here.
 */
export default function BillingPage() {
  redirect("/dashboard/settings");
}
