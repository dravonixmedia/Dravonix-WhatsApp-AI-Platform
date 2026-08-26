import Link from "next/link";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

/**
 * Phase 7A: read-only Super Admin invoice list. Uses the existing
 * invoices table (Migration 7) directly -- no new RPC, no new schema. RLS's
 * invoices_select_member policy already grants is_platform_staff() a
 * platform-wide SELECT, so this runs under the caller's own session (never
 * service-role), matching every other admin page in this tree. No
 * edit/delete/mark-paid/refund action exists on this page by design --
 * invoices remain Super-Admin read-only in Phase 7A.
 */

interface InvoiceRow {
  id: string;
  invoice_number: string;
  kind: string;
  status: string;
  currency: string;
  total: number;
  due_date: string | null;
  paid_date: string | null;
  created_at: string;
  company_id: string;
  companies: { name: string } | { name: string }[] | null;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "dvx-badge--neutral",
  pending: "dvx-badge--warning",
  partially_paid: "dvx-badge--warning",
  paid: "dvx-badge--success",
  void: "dvx-badge--neutral",
  refunded: "dvx-badge--neutral",
};

const KIND_LABEL: Record<string, string> = {
  subscription: "Subscription",
  service_charge: "Service charge",
  usage_overage: "Usage overage",
};

const RESULT_LIMIT = 100;

function money(amount: number, currency: string): string {
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

export default async function AdminInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; status?: string; kind?: string }>;
}) {
  const { company, status, kind } = await searchParams;
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("invoices")
    .select(
      "id, invoice_number, kind, status, currency, total, due_date, paid_date, created_at, company_id, companies (name)",
    )
    .order("created_at", { ascending: false })
    .limit(RESULT_LIMIT);

  if (status) query = query.eq("status", status);
  if (kind) query = query.eq("kind", kind);

  // Company name search is resolved via a separate lookup (rather than a
  // PostgREST embedded-resource filter) to keep this query's shape identical
  // to every other admin list page's plain .eq()/.ilike() filtering.
  if (company) {
    const { data: matchingCompanies, error: companyError } = await supabase
      .from("companies")
      .select("id")
      .ilike("name", `%${company}%`);
    if (companyError) throw companyError;
    const companyIds = (matchingCompanies ?? []).map((c) => c.id);
    query = query.in(
      "company_id",
      companyIds.length > 0 ? companyIds : ["00000000-0000-0000-0000-000000000000"],
    );
  }

  const { data, error } = await query;
  if (error) throw error;
  const invoices = (data ?? []) as InvoiceRow[];

  return (
    <div>
      <h1 className="dvx-page-title">Invoices</h1>
      <p className="dvx-muted">
        Read-only, most recent {RESULT_LIMIT} invoices platform-wide. No edit, delete, mark-paid, or
        refund action exists here -- see the company's own Billing page or
        admin_billing_lifecycle_overview for lifecycle status.
      </p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <form style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
          <input
            className="dvx-input"
            name="company"
            placeholder="Search by company name"
            defaultValue={company ?? ""}
          />
          <select
            className="dvx-input"
            name="kind"
            defaultValue={kind ?? ""}
            style={{ maxWidth: 200 }}
          >
            <option value="">All kinds</option>
            <option value="subscription">Subscription</option>
            <option value="service_charge">Service charge</option>
            <option value="usage_overage">Usage overage</option>
          </select>
          <select
            className="dvx-input"
            name="status"
            defaultValue={status ?? ""}
            style={{ maxWidth: 200 }}
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="pending">Pending</option>
            <option value="partially_paid">Partially paid</option>
            <option value="paid">Paid</option>
            <option value="void">Void</option>
            <option value="refunded">Refunded</option>
          </select>
          <button className="dvx-button dvx-button--secondary" type="submit">
            Filter
          </button>
        </form>

        {invoices.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No invoices match this filter.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {invoices.map((invoice) => {
              const companyRow = Array.isArray(invoice.companies)
                ? invoice.companies[0]
                : invoice.companies;
              return (
                <Link
                  key={invoice.id}
                  href={`/admin/companies/${invoice.company_id}`}
                  className="dvx-team-member-row"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <span className="dvx-team-member-name">
                    {invoice.invoice_number}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {companyRow?.name ?? "Unknown company"} ·{" "}
                      {KIND_LABEL[invoice.kind] ?? invoice.kind} ·{" "}
                      {money(invoice.total, invoice.currency)} · due {formatDate(invoice.due_date)}
                      {invoice.paid_date ? ` · paid ${formatDate(invoice.paid_date)}` : ""}
                    </span>
                  </span>
                  <span
                    className={`dvx-badge ${STATUS_BADGE[invoice.status] ?? "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {invoice.status.replace(/_/g, " ")}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
