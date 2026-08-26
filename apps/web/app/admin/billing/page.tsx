import Link from "next/link";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

/**
 * Phase 7A: this page is a pure presentation layer over the existing
 * Migration 30 RPC admin_billing_lifecycle_overview() -- every field shown
 * below is a column that RPC already returns. No new billing calculation is
 * introduced here (the RPC itself computes days_until_due/is_overdue from
 * the company's own timezone); this page only groups/counts/renders what it
 * gets back. See supabase/migrations/00000000000030_billing_automation.sql
 * for the RPC's exact definition and gating (current_platform_role() =
 * 'super_admin', re-checked independently of this route's own layout gate).
 */

type LifecycleRow = {
  company_id: string;
  company_name: string;
  subscription_state: string;
  current_period_end: string | null;
  grace_period_end: string | null;
  latest_invoice_id: string | null;
  latest_invoice_number: string | null;
  latest_invoice_status: string | null;
  latest_invoice_due_date: string | null;
  latest_invoice_total: number | null;
  latest_invoice_currency: string | null;
  days_until_due: number | null;
  is_overdue: boolean | null;
  last_paid_invoice_id: string | null;
  last_paid_date: string | null;
  last_paid_amount: number | null;
};

const STATE_BADGE: Record<string, string> = {
  active: "dvx-badge--success",
  trial: "dvx-badge--info",
  onboarding: "dvx-badge--info",
  payment_due: "dvx-badge--warning",
  grace_period: "dvx-badge--warning",
  suspended: "dvx-badge--danger",
  manually_suspended: "dvx-badge--danger",
  cancel_at_period_end: "dvx-badge--warning",
  cancelled: "dvx-badge--neutral",
  closed: "dvx-badge--neutral",
};

const INVOICE_STATUS_BADGE: Record<string, string> = {
  paid: "dvx-badge--success",
  pending: "dvx-badge--warning",
  failed: "dvx-badge--danger",
  void: "dvx-badge--neutral",
};

function money(amount: number | null, currency: string | null): string {
  if (amount === null || !currency) return "--";
  return `${currency} ${amount.toFixed(2)}`;
}

function formatDate(value: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

/**
 * Presentation-level aggregation over the RPC's own rows -- not a new
 * billing calculation. "Suspended" combines the two DB states that both
 * mean "not serviceable due to non-payment/manual action"
 * (SERVICE_BLOCKED_STATES in packages/billing/src/stateMachine.ts), purely
 * for a compact summary strip.
 */
interface LifecycleSummary {
  active: number;
  trial: number;
  payment_due: number;
  grace_period: number;
  suspended: number;
  cancel_at_period_end: number;
  overdue: number;
}

function summarize(rows: LifecycleRow[]): LifecycleSummary {
  const summary: LifecycleSummary = {
    active: 0,
    trial: 0,
    payment_due: 0,
    grace_period: 0,
    suspended: 0,
    cancel_at_period_end: 0,
    overdue: 0,
  };
  for (const row of rows) {
    if (row.subscription_state === "suspended" || row.subscription_state === "manually_suspended") {
      summary.suspended += 1;
    } else if (row.subscription_state in summary) {
      summary[row.subscription_state as keyof Omit<LifecycleSummary, "overdue">] += 1;
    }
    if (row.is_overdue) summary.overdue += 1;
  }
  return summary;
}

export default async function AdminBillingPage() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("admin_billing_lifecycle_overview");
  if (error) throw error;
  const rows = ((data ?? []) as LifecycleRow[])
    .slice()
    .sort((a, b) => a.company_name.localeCompare(b.company_name));
  const summary = summarize(rows);

  const SUMMARY_TILES: { label: string; value: number; badge: string }[] = [
    { label: "Active", value: summary.active, badge: "dvx-badge--success" },
    { label: "Trial", value: summary.trial, badge: "dvx-badge--info" },
    { label: "Payment Due", value: summary.payment_due, badge: "dvx-badge--warning" },
    { label: "Grace Period", value: summary.grace_period, badge: "dvx-badge--warning" },
    { label: "Suspended", value: summary.suspended, badge: "dvx-badge--danger" },
    {
      label: "Cancel at Period End",
      value: summary.cancel_at_period_end,
      badge: "dvx-badge--warning",
    },
    { label: "Overdue", value: summary.overdue, badge: "dvx-badge--danger" },
  ];

  return (
    <div>
      <h1 className="dvx-page-title">Billing Operations</h1>
      <p className="dvx-muted">
        Platform-wide billing lifecycle overview, reusing the existing
        admin_billing_lifecycle_overview RPC. Read-only -- see Invoices and Payments for detailed
        records.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "0.75rem",
          marginTop: "1.5rem",
        }}
      >
        {SUMMARY_TILES.map((tile) => (
          <div key={tile.label} className="dvx-card" style={{ textAlign: "center" }}>
            <div style={{ fontSize: "1.5rem", fontWeight: 700 }}>{tile.value}</div>
            <span
              className={`dvx-badge ${tile.badge}`}
              style={{ fontSize: "0.68rem", marginTop: "0.35rem" }}
            >
              {tile.label}
            </span>
          </div>
        ))}
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        {rows.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No companies with an active subscription yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {rows.map((row) => (
              <Link
                key={row.company_id}
                href={`/admin/companies/${row.company_id}`}
                className="dvx-team-member-row"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <span className="dvx-team-member-name">
                  {row.company_name}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    {row.latest_invoice_number
                      ? `${row.latest_invoice_number} · ${money(
                          row.latest_invoice_total,
                          row.latest_invoice_currency,
                        )} · due ${formatDate(row.latest_invoice_due_date)}`
                      : "No invoice yet"}
                    {row.grace_period_end
                      ? ` · grace ends ${formatDate(row.grace_period_end)}`
                      : ""}
                  </span>
                </span>
                <span style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                  {row.is_overdue ? (
                    <span className="dvx-badge dvx-badge--danger" style={{ fontSize: "0.7rem" }}>
                      Overdue
                    </span>
                  ) : null}
                  {row.latest_invoice_status ? (
                    <span
                      className={`dvx-badge ${
                        INVOICE_STATUS_BADGE[row.latest_invoice_status] ?? "dvx-badge--neutral"
                      }`}
                      style={{ fontSize: "0.7rem" }}
                    >
                      {row.latest_invoice_status}
                    </span>
                  ) : null}
                  <span
                    className={`dvx-badge ${STATE_BADGE[row.subscription_state] ?? "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {row.subscription_state.replace(/_/g, " ")}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
