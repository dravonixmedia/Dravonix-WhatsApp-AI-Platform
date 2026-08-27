import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeUsageSummaryUpserts,
  type RawUsageEvent,
  type SubscriptionPeriod,
} from "./usageAggregation.js";

export interface GeneratedInvoice {
  companyId: string;
  invoiceId: string;
  invoiceNumber: string;
}

export interface AdvancedSubscription {
  companyId: string;
  subscriptionId: string;
  newState: string;
}

export interface SuspendedSubscription {
  companyId: string;
  subscriptionId: string;
}

export interface SentReminder {
  companyId: string;
  invoiceId: string;
  stage: string;
}

export interface FinalizedCancellation {
  companyId: string;
  subscriptionId: string;
}

export interface UsageAggregationResult {
  companiesProcessed: number;
  summariesUpserted: number;
}

/**
 * Everything the daily billing scheduler needs. Every method above
 * aggregateUsage is a thin wrapper around a migration-30/32 SECURITY
 * DEFINER RPC -- all transactional/idempotency/tenant-scoping logic for
 * those lives in SQL, not here.
 *
 * aggregateUsage is a deliberate exception (P0 usage-repair PHASE 8): it is
 * plain SELECT + upsert against usage_events/usage_summaries via this
 * service-role client, not a new RPC -- both tables already carry every
 * constraint this needs (usage_summaries' own
 * unique(company_id, metric, period_start, period_end)), so a new
 * migration/RPC would add a database object with no schema-capability this
 * couldn't already do safely. See usageAggregation.ts for the pure
 * computation this wraps.
 */
export interface BillingSchedulerRepository {
  generateDueInvoices(): Promise<GeneratedInvoice[]>;
  advanceOverdueSubscriptions(): Promise<AdvancedSubscription[]>;
  suspendExpiredGraceSubscriptions(): Promise<SuspendedSubscription[]>;
  finalizeScheduledCancellations(): Promise<FinalizedCancellation[]>;
  sendDueReminders(): Promise<SentReminder[]>;
  aggregateUsage(): Promise<UsageAggregationResult>;
}

/**
 * Production implementation, calling the four service_role-only migration-30
 * RPCs. Uses the service-role client (bypasses RLS), same convention as
 * SupabaseRazorpayPaymentRepository (apps/api) and
 * SupabaseHandoverWorkerRepository (outbound-reconciler) -- this runs
 * entirely server-side on a Cron Trigger, with no end-user JWT.
 */
export class SupabaseBillingSchedulerRepository implements BillingSchedulerRepository {
  constructor(private readonly client: SupabaseClient) {}

  async generateDueInvoices(): Promise<GeneratedInvoice[]> {
    const { data, error } = await this.client.rpc("generate_due_subscription_invoices");
    if (error) throw error;
    return (
      (data ?? []) as Array<{ company_id: string; invoice_id: string; invoice_number: string }>
    ).map((row) => ({
      companyId: row.company_id,
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
    }));
  }

  async advanceOverdueSubscriptions(): Promise<AdvancedSubscription[]> {
    const { data, error } = await this.client.rpc("advance_overdue_subscriptions");
    if (error) throw error;
    return (
      (data ?? []) as Array<{ company_id: string; subscription_id: string; new_state: string }>
    ).map((row) => ({
      companyId: row.company_id,
      subscriptionId: row.subscription_id,
      newState: row.new_state,
    }));
  }

  async suspendExpiredGraceSubscriptions(): Promise<SuspendedSubscription[]> {
    const { data, error } = await this.client.rpc("suspend_expired_grace_subscriptions");
    if (error) throw error;
    return ((data ?? []) as Array<{ company_id: string; subscription_id: string }>).map((row) => ({
      companyId: row.company_id,
      subscriptionId: row.subscription_id,
    }));
  }

  async finalizeScheduledCancellations(): Promise<FinalizedCancellation[]> {
    const { data, error } = await this.client.rpc("finalize_scheduled_subscription_cancellations");
    if (error) throw error;
    return ((data ?? []) as Array<{ company_id: string; subscription_id: string }>).map((row) => ({
      companyId: row.company_id,
      subscriptionId: row.subscription_id,
    }));
  }

  async sendDueReminders(): Promise<SentReminder[]> {
    const { data, error } = await this.client.rpc("send_due_billing_reminders");
    if (error) throw error;
    return ((data ?? []) as Array<{ company_id: string; invoice_id: string; stage: string }>).map(
      (row) => ({
        companyId: row.company_id,
        invoiceId: row.invoice_id,
        stage: row.stage,
      }),
    );
  }

  async aggregateUsage(): Promise<UsageAggregationResult> {
    const { data: subscriptionRows, error: subscriptionsError } = await this.client
      .from("subscriptions")
      .select("company_id, current_period_start, current_period_end")
      .not("current_period_start", "is", null)
      .not("current_period_end", "is", null);
    if (subscriptionsError) throw subscriptionsError;

    const subscriptions: SubscriptionPeriod[] = (
      (subscriptionRows ?? []) as Array<{
        company_id: string;
        current_period_start: string;
        current_period_end: string;
      }>
    ).map((row) => ({
      companyId: row.company_id,
      periodStart: row.current_period_start,
      periodEnd: row.current_period_end,
    }));
    if (subscriptions.length === 0) return { companiesProcessed: 0, summariesUpserted: 0 };

    const companyIds = [...new Set(subscriptions.map((s) => s.companyId))];
    const earliestPeriodStart = subscriptions.reduce(
      (earliest, s) => (s.periodStart < earliest ? s.periodStart : earliest),
      subscriptions[0]!.periodStart,
    );

    const { data: eventRows, error: eventsError } = await this.client
      .from("usage_events")
      .select("company_id, metric, quantity, is_billable, occurred_at")
      .in("company_id", companyIds)
      .gte("occurred_at", earliestPeriodStart);
    if (eventsError) throw eventsError;

    const events: RawUsageEvent[] = (
      (eventRows ?? []) as Array<{
        company_id: string;
        metric: RawUsageEvent["metric"];
        quantity: number | string;
        is_billable: boolean;
        occurred_at: string;
      }>
    ).map((row) => ({
      companyId: row.company_id,
      metric: row.metric,
      quantity: Number(row.quantity),
      isBillable: row.is_billable,
      occurredAt: row.occurred_at,
    }));

    const upserts = computeUsageSummaryUpserts(subscriptions, events);
    if (upserts.length === 0) {
      return { companiesProcessed: subscriptions.length, summariesUpserted: 0 };
    }

    const { error: upsertError } = await this.client.from("usage_summaries").upsert(
      upserts.map((u) => ({
        company_id: u.companyId,
        metric: u.metric,
        period_start: u.periodStart,
        period_end: u.periodEnd,
        total_quantity: u.totalQuantity,
        billable_quantity: u.billableQuantity,
      })),
      { onConflict: "company_id,metric,period_start,period_end" },
    );
    if (upsertError) throw upsertError;

    return { companiesProcessed: subscriptions.length, summariesUpserted: upserts.length };
  }
}
