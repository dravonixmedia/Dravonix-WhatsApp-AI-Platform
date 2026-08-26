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
  remindersSent: number;
}

/**
 * One daily billing lifecycle pass (Phase 6C). Runs the four migration-30
 * RPCs in dependency order:
 *   1. generate_due_subscription_invoices -- so a subscription that just
 *      lapsed today (or was never invoiced before this migration existed)
 *      has its invoice on record before the next step looks for one.
 *   2. advance_overdue_subscriptions -- active/trial -> payment_due ->
 *      grace_period for anything whose period has lapsed unpaid.
 *   3. suspend_expired_grace_subscriptions -- grace_period -> suspended for
 *      anything whose grace period has actually elapsed.
 *   4. send_due_billing_reminders -- dashboard-visible reminder state for
 *      every still-pending subscription invoice (including a subscription
 *      that just entered grace_period in step 2/3 above).
 * Each RPC is independently idempotent (see migration 30), so if this whole
 * pass is retried, overlaps with another run, or crashes partway through,
 * every step it does reach is still safe to repeat. No email provider is
 * ever invoked here -- see migration 30's header comment for why.
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

  const reminders = await deps.billingRepo.sendDueReminders();
  if (reminders.length > 0) {
    deps.logger.info("Sent billing reminders", {
      count: reminders.length,
      stages: reminders.map((r) => r.stage),
    });
  }

  return {
    invoicesGenerated: generated.length,
    subscriptionsAdvanced: advanced.length,
    subscriptionsSuspended: suspended.length,
    remindersSent: reminders.length,
  };
}
