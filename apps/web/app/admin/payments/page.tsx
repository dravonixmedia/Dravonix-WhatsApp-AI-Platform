import Link from "next/link";
import {
  buildMemberIdentityByUserId,
  resolveMemberIdentity,
  type CompanyMemberIdentityRow,
} from "../../../lib/memberIdentity.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

/**
 * Phase 7A: read-only Super Admin payments list. Uses the existing
 * payments/payment_attempts tables (Migration 7) directly -- no new RPC, no
 * new schema. RLS already grants is_platform_staff() platform-wide SELECT
 * on both tables.
 *
 * STRICT DATA SAFETY (Phase 7A instruction): this page must never render a
 * Razorpay secret, webhook signature, service-role credential, card/bank
 * detail, or a raw provider payload. payment_attempts.raw_payload is
 * therefore never selected at all (not fetched, not just hidden) -- only
 * its status/error/timestamps are shown, which is exactly what
 * reconciliation debugging needs. No mutation control (approve/reject/
 * refund) exists on this page.
 */

interface PaymentRow {
  id: string;
  company_id: string;
  invoice_id: string | null;
  method: string;
  status: string;
  amount: number;
  currency: string;
  provider_payment_id: string | null;
  provider_reference: string | null;
  submitted_by_user_id: string | null;
  approved_at: string | null;
  created_at: string;
  companies: { name: string } | { name: string }[] | null;
  invoices: { invoice_number: string } | { invoice_number: string }[] | null;
}

interface PaymentAttemptRow {
  id: string;
  company_id: string;
  provider: string;
  status: string;
  error: string | null;
  processed_at: string | null;
  created_at: string;
  companies: { name: string } | { name: string }[] | null;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "dvx-badge--warning",
  succeeded: "dvx-badge--success",
  failed: "dvx-badge--danger",
  refunded: "dvx-badge--neutral",
};

const METHOD_LABEL: Record<string, string> = {
  razorpay: "Razorpay",
  manual_bank_transfer: "Manual bank transfer",
  manual_upi: "Manual UPI",
  other: "Other",
};

const RESULT_LIMIT = 100;
const RECENT_ATTEMPTS_LIMIT = 20;

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; status?: string; method?: string }>;
}) {
  const { company, status, method } = await searchParams;
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("payments")
    .select(
      "id, company_id, invoice_id, method, status, amount, currency, provider_payment_id, provider_reference, submitted_by_user_id, approved_at, created_at, companies (name), invoices (invoice_number)",
    )
    .order("created_at", { ascending: false })
    .limit(RESULT_LIMIT);

  if (status) query = query.eq("status", status);
  if (method) query = query.eq("method", method);

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
  const payments = (data ?? []) as PaymentRow[];

  const { data: attemptData, error: attemptError } = await supabase
    .from("payment_attempts")
    .select("id, company_id, provider, status, error, processed_at, created_at, companies (name)")
    .order("created_at", { ascending: false })
    .limit(RECENT_ATTEMPTS_LIMIT);
  if (attemptError) throw attemptError;
  const attempts = (attemptData ?? []) as PaymentAttemptRow[];

  const companyIdsForIdentity = [...new Set(payments.map((p) => p.company_id))];
  const identityResults = await Promise.all(
    companyIdsForIdentity.map((companyId) =>
      supabase
        .rpc("list_company_member_identities", { p_company_id: companyId })
        .then(({ data: rows }) => (rows ?? []) as CompanyMemberIdentityRow[]),
    ),
  );
  const memberIdentityByUserId = buildMemberIdentityByUserId(identityResults.flat());

  function submitterLabel(userId: string | null): string {
    if (!userId) return "--";
    const identity = memberIdentityByUserId.get(userId);
    return resolveMemberIdentity({ name: identity?.displayName ?? null, email: null, userId })
      .primary;
  }

  return (
    <div>
      <h1 className="dvx-page-title">Payments</h1>
      <p className="dvx-muted">
        Read-only, most recent {RESULT_LIMIT} payments platform-wide. No approve, reject, or refund
        action exists here. Provider secrets, signatures, and raw webhook payloads are never
        rendered.
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
            name="method"
            defaultValue={method ?? ""}
            style={{ maxWidth: 200 }}
          >
            <option value="">All methods</option>
            <option value="razorpay">Razorpay</option>
            <option value="manual_bank_transfer">Manual bank transfer</option>
            <option value="manual_upi">Manual UPI</option>
            <option value="other">Other</option>
          </select>
          <select
            className="dvx-input"
            name="status"
            defaultValue={status ?? ""}
            style={{ maxWidth: 200 }}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
          </select>
          <button className="dvx-button dvx-button--secondary" type="submit">
            Filter
          </button>
        </form>

        {payments.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No payments match this filter.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {payments.map((payment) => {
              const companyRow = Array.isArray(payment.companies)
                ? payment.companies[0]
                : payment.companies;
              const invoiceRow = Array.isArray(payment.invoices)
                ? payment.invoices[0]
                : payment.invoices;
              return (
                <Link
                  key={payment.id}
                  href={`/admin/companies/${payment.company_id}`}
                  className="dvx-team-member-row"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <span className="dvx-team-member-name">
                    {companyRow?.name ?? "Unknown company"}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {METHOD_LABEL[payment.method] ?? payment.method} ·{" "}
                      {money(payment.amount, payment.currency)}
                      {invoiceRow?.invoice_number ? ` · ${invoiceRow.invoice_number}` : ""}
                      {payment.provider_reference ? ` · order ${payment.provider_reference}` : ""}
                      {payment.provider_payment_id
                        ? ` · payment ${payment.provider_payment_id}`
                        : ""}
                      {" · submitted by "}
                      {submitterLabel(payment.submitted_by_user_id)}
                      {" · "}
                      {formatDateTime(payment.created_at)}
                    </span>
                  </span>
                  <span
                    className={`dvx-badge ${STATUS_BADGE[payment.status] ?? "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {payment.status}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>
          Recent provider webhook attempts
        </div>
        <p className="dvx-muted" style={{ fontSize: "0.78rem", margin: "0 0 0.75rem" }}>
          Status/error only, for reconciliation debugging -- the raw provider payload is never shown
          here.
        </p>
        {attempts.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No recorded webhook attempts yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {attempts.map((attempt) => {
              const companyRow = Array.isArray(attempt.companies)
                ? attempt.companies[0]
                : attempt.companies;
              return (
                <div key={attempt.id} className="dvx-team-member-row">
                  <span className="dvx-team-member-name">
                    {companyRow?.name ?? "Unknown company"}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {attempt.provider} · {formatDateTime(attempt.created_at)}
                      {attempt.error ? ` · ${attempt.error}` : ""}
                    </span>
                  </span>
                  <span
                    className={`dvx-badge ${STATUS_BADGE[attempt.status] ?? "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {attempt.status}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
