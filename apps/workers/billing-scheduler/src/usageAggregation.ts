import type { UsageMetric } from "@dravonix/database";

/**
 * One company's current billing period, sourced from
 * subscriptions.current_period_start/current_period_end -- deliberately the
 * SAME billing-period definition already used by SupabaseEntitlementRepository's
 * monthly_messages count (apps/web and apps/workers/message-consumer), so
 * usage_summaries and the client billing entitlement counter never present
 * two different numbers for what claims to be the same "this period" concept
 * (P0 usage-repair PHASE 9/11). A company with no subscription row (no
 * period bounds) is simply excluded -- there is no period to attribute its
 * usage_events to.
 */
export interface SubscriptionPeriod {
  companyId: string;
  /** ISO timestamp -- subscriptions.current_period_start. */
  periodStart: string;
  /** ISO timestamp -- subscriptions.current_period_end. */
  periodEnd: string;
}

/** One raw usage_events row (the columns computeUsageSummaryUpserts needs). */
export interface RawUsageEvent {
  companyId: string;
  metric: UsageMetric;
  quantity: number;
  isBillable: boolean;
  /** ISO timestamp -- usage_events.occurred_at. */
  occurredAt: string;
}

/** One usage_summaries row to upsert. */
export interface UsageSummaryUpsert {
  companyId: string;
  metric: UsageMetric;
  /** Date-only (YYYY-MM-DD), matching usage_summaries.period_start's `date` column type. */
  periodStart: string;
  periodEnd: string;
  totalQuantity: number;
  billableQuantity: number;
}

function toDateOnly(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * Pure aggregation: for each company's current subscription billing period,
 * sums raw usage_events into one row per (company, metric) actually present
 * in that period -- metrics with zero events in the period produce no row
 * (readers already treat "no row" as zero; see admin/usage/page.tsx).
 *
 * A half-open interval [periodStart, periodEnd) -- an event exactly at
 * periodEnd belongs to the NEXT period, matching current_period_end's own
 * meaning as the instant the next period begins (see migrations 30/32's
 * period-rollover RPCs).
 *
 * Idempotent by construction: this recomputes the full total from every
 * matching raw row every time, so calling it again (whether because the
 * scheduler reran, or because more usage_events arrived since the last run)
 * always yields the correct current total for the period -- there is
 * nothing to double-count, and late-arriving usage is naturally picked up
 * on the next run rather than needing separate reconciliation logic. The
 * caller upserts the result against usage_summaries' own
 * unique(company_id, metric, period_start, period_end) constraint, which
 * replaces (not adds to) any prior row for the same key.
 */
export function computeUsageSummaryUpserts(
  subscriptions: SubscriptionPeriod[],
  events: RawUsageEvent[],
): UsageSummaryUpsert[] {
  const results: UsageSummaryUpsert[] = [];

  for (const subscription of subscriptions) {
    const periodStartMs = Date.parse(subscription.periodStart);
    const periodEndMs = Date.parse(subscription.periodEnd);
    const totals = new Map<UsageMetric, { total: number; billable: number }>();

    for (const event of events) {
      if (event.companyId !== subscription.companyId) continue;
      const occurredAtMs = Date.parse(event.occurredAt);
      if (occurredAtMs < periodStartMs || occurredAtMs >= periodEndMs) continue;

      const bucket = totals.get(event.metric) ?? { total: 0, billable: 0 };
      bucket.total += event.quantity;
      if (event.isBillable) bucket.billable += event.quantity;
      totals.set(event.metric, bucket);
    }

    for (const [metric, bucket] of totals) {
      results.push({
        companyId: subscription.companyId,
        metric,
        periodStart: toDateOnly(subscription.periodStart),
        periodEnd: toDateOnly(subscription.periodEnd),
        totalQuantity: bucket.total,
        billableQuantity: bucket.billable,
      });
    }
  }

  return results;
}
