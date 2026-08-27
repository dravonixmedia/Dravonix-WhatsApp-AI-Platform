import type { Logger } from "@dravonix/observability";
import type { BillingSchedulerRepository } from "./billingRepository.js";

export interface RunBillingLifecycleDeps {
  billingRepo: BillingSchedulerRepository;
  logger: Logger;
}

export interface BillingLifecycleResult {
  invoicesGenerated: number;
  subscriptionsAdvanced: number;
  subscriptionsSuspended: number;
  cancellationsFinalized: number;
  remindersSent: number;
  usageSummariesUpserted: number;
}

/**
 * One daily billing lifecycle pass (Phase 6C, extended by Phase 7B). Runs
 * five RPCs in dependency order:
 *   1. generate_due_subscription_invoices -- so a subscription that just
 *      lapsed today (or was never invoiced before this migration existed)
 *      has its invoice on record before the next step looks for one.
 *   2. advance_overdue_subscriptions -- active/trial -> payment_due ->
 *      grace_period for anything whose period has lapsed unpaid.
 *   3. suspend_expired_grace_subscriptions -- grace_period -> suspended for
 *      anything whose grace period has actually elapsed.
 *   4. finalize_scheduled_subscription_cancellations (migration 32) --
 *      cancel_at_period_end -> cancelled for anything whose scheduled
 *      cancellation period has actually ended. Runs BEFORE step 5 on
 *      purpose: a subscription finalized to cancelled in this same pass
 *      must never receive a reminder in that same pass -- send_due_billing_
 *      reminders already excludes cancelled subscriptions, so ordering this
 *      step first makes that exclusion take effect within a single run
 *      rather than waiting for tomorrow's pass.
 *   5. send_due_billing_reminders -- dashboard-visible reminder state for
 *      every still-pending subscription invoice (including a subscription
 *      that just entered grace_period in step 2/3 above).
 *   6. aggregateUsage (P0 usage repair) -- recomputes usage_summaries from
 *      raw usage_events for every company's current subscription billing
 *      period. Runs last since it only reads/summarizes data the steps
 *      above never write (subscriptions/usage_events), so ordering relative
 *      to them doesn't matter for correctness -- placed last simply so a
 *      failure here can never block the higher-priority billing-state
 *      transitions above it.
 * Each RPC-backed step is independently idempotent (see migrations 30/32);
 * aggregateUsage is idempotent by construction (full recompute + upsert
 * against usage_summaries' own unique constraint -- see
 * usageAggregation.ts). So if this whole pass is retried, overlaps with
 * another run, or crashes partway through, every step it does reach is
 * still safe to repeat. No email provider is ever invoked here -- see
 * migration 30's header comment for why.
 */
export async function runBillingLifecycle(
  deps: RunBillingLifecycleDeps,
): Promise<BillingLifecycleResult> {
  const generated = await deps.billingRepo.generateDueInvoices();
  if (generated.length > 0) {
    deps.logger.info("Generated upcoming subscription invoices", {
      count: generated.length,
      invoiceNumbers: generated.map((g) => g.invoiceNumber),
    });
  }

  const advanced = await deps.billingRepo.advanceOverdueSubscriptions();
  if (advanced.length > 0) {
    deps.logger.warn("Advanced overdue subscriptions into grace period", {
      count: advanced.length,
      companyIds: advanced.map((a) => a.companyId),
    });
  }

  const suspended = await deps.billingRepo.suspendExpiredGraceSubscriptions();
  if (suspended.length > 0) {
    deps.logger.warn("Suspended subscriptions whose grace period expired", {
      count: suspended.length,
      companyIds: suspended.map((s) => s.companyId),
    });
  }

  const cancellationsFinalized = await deps.billingRepo.finalizeScheduledCancellations();
  if (cancellationsFinalized.length > 0) {
    deps.logger.info("Finalized scheduled subscription cancellations", {
      count: cancellationsFinalized.length,
      companyIds: cancellationsFinalized.map((c) => c.companyId),
    });
  }

  const reminders = await deps.billingRepo.sendDueReminders();
  if (reminders.length > 0) {
    deps.logger.info("Sent billing reminders", {
      count: reminders.length,
      stages: reminders.map((r) => r.stage),
    });
  }

  const usageAggregation = await deps.billingRepo.aggregateUsage();
  if (usageAggregation.summariesUpserted > 0) {
    deps.logger.info("Aggregated usage_events into usage_summaries", {
      companiesProcessed: usageAggregation.companiesProcessed,
      summariesUpserted: usageAggregation.summariesUpserted,
    });
  }

  return {
    invoicesGenerated: generated.length,
    subscriptionsAdvanced: advanced.length,
    subscriptionsSuspended: suspended.length,
    cancellationsFinalized: cancellationsFinalized.length,
    remindersSent: reminders.length,
    usageSummariesUpserted: usageAggregation.summariesUpserted,
  };
}
