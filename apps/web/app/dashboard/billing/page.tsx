import Link from "next/link";
import {
  daysBetween,
  invoiceDisplayStatus,
  localDateString,
  toLocalDateString,
} from "../../../lib/billingLifecycleDisplay.js";
import { formatDateTime } from "../../../lib/formatDateTime.js";
import {
  buildMemberIdentityByUserId,
  resolveMemberIdentity,
  type CompanyMemberIdentityRow,
} from "../../../lib/memberIdentity.js";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getCompanyTimezone } from "../../../lib/repositories/companyTimezone.js";
import {
  getBillingSubscription,
  listBillingInvoices,
  listBillingPayments,
} from "../../../lib/repositories/billingRepository.js";
import { SupabaseEntitlementRepository } from "../../../lib/repositories/supabaseEntitlementRepository.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { MakePaymentButton } from "./MakePaymentButton.js";

export const dynamic = "force-dynamic";

/** Invoice statuses a payment can actually be made against -- draft (not yet finalized), paid, void, and refunded are all excluded. */
const PAYABLE_INVOICE_STATUSES = new Set(["pending", "partially_paid"]);

const INVOICE_STATUS_BADGE: Record<string, string> = {
  draft: "dvx-badge--neutral",
  pending: "dvx-badge--warning",
  partially_paid: "dvx-badge--warning",
  paid: "dvx-badge--success",
  void: "dvx-badge--neutral",
  refunded: "dvx-badge--neutral",
  overdue: "dvx-badge--danger",
};

const PAYMENT_STATUS_BADGE: Record<string, string> = {
  pending: "dvx-badge--warning",
  succeeded: "dvx-badge--success",
  failed: "dvx-badge--danger",
  refunded: "dvx-badge--neutral",
};

function PermissionDenied() {
  return (
    <div className="dvx-card" style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Billing</h1>
      <p className="dvx-muted" style={{ margin: 0 }}>
        Your role does not have permission to view billing.
      </p>
    </div>
  );
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

/**
 * Company Accounts' primary landing page (Phase 6) -- also available to
 * company_owner/company_admin (all three hold billing.view). Phase 6B adds
 * a real Pay Now action per payable invoice, gated on capabilities.canPayBilling
 * (billing.pay) -- never a role-name check, so Manager/Team Leader/Sales
 * Person (who hold neither billing.view nor billing.pay) never see this
 * page or the button at all, and it is capability-derived so any future
 * role with billing.pay gets it automatically.
 */
export default async function BillingPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewBilling) return <PermissionDenied />;

  const supabase = await createServerSupabaseClient();
  const entitlementRepo = new SupabaseEntitlementRepository(supabase);

  const [
    subscription,
    invoices,
    payments,
    entitlementSnapshot,
    companyTimezone,
    memberIdentityRows,
  ] = await Promise.all([
    getBillingSubscription(supabase, session.activeCompanyId),
    listBillingInvoices(supabase, session.activeCompanyId),
    listBillingPayments(supabase, session.activeCompanyId),
    entitlementRepo.getSnapshot(session.activeCompanyId),
    getCompanyTimezone(supabase, session.activeCompanyId),
    supabase
      .rpc("list_company_member_identities", { p_company_id: session.activeCompanyId })
      .then(({ data }) => (data ?? []) as CompanyMemberIdentityRow[]),
  ]);
  const memberIdentityByUserId = buildMemberIdentityByUserId(memberIdentityRows);

  const ownUserId = session.userId;
  function submitterLabel(userId: string | null): string {
    if (!userId) return "—";
    if (userId === ownUserId) return "You";
    const identity = memberIdentityByUserId.get(userId);
    return resolveMemberIdentity({ name: identity?.displayName ?? null, email: null, userId })
      .primary;
  }

  const messagesLimit = entitlementSnapshot.features.monthly_messages?.numericLimit ?? null;
  const messagesUsed = entitlementSnapshot.usage.monthly_messages ?? 0;

  // Phase 6C derived billing-lifecycle display data -- all computed from
  // data already fetched above, no additional query needed. localToday is
  // the company's own local calendar date (never server/UTC "today").
  const localToday = localDateString(companyTimezone);
  const daysUntilRenewal =
    subscription?.currentPeriodEnd != null
      ? daysBetween(
          localToday,
          toLocalDateString(new Date(subscription.currentPeriodEnd), companyTimezone),
        )
      : null;
  const lastPaidInvoice = invoices
    .filter((invoice) => invoice.status === "paid" && invoice.paidDate)
    .sort((a, b) => (b.paidDate! > a.paidDate! ? 1 : -1))[0];

  return (
    <div>
      <h1 className="dvx-page-title">Billing</h1>
      <p className="dvx-muted">Your plan, subscription, usage, invoices, and payment history.</p>

      <div className="dvx-card-grid dvx-card-grid--wide" style={{ marginTop: "1.5rem" }}>
        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.6rem" }}>
            Finance overview
          </div>
          {subscription ? (
            <>
              <div
                style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}
              >
                <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
                  Current plan
                </span>
                <span style={{ fontSize: "0.85rem" }}>
                  {subscription.plan?.name ?? "Not assigned"}
                </span>
              </div>
              <div
                style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}
              >
                <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
                  Subscription status
                </span>
                <span style={{ fontSize: "0.85rem" }}>{subscription.state.replace(/_/g, " ")}</span>
              </div>
              {subscription.plan ? (
                <div
                  style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}
                >
                  <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
                    Monthly price
                  </span>
                  <span style={{ fontSize: "0.85rem" }}>
                    {money(subscription.plan.monthlyPrice, subscription.plan.currency)}
                  </span>
                </div>
              ) : null}
              <div
                style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}
              >
                <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
                  Billing period
                </span>
                <span style={{ fontSize: "0.85rem" }}>
                  {subscription.currentPeriodStart
                    ? `${formatDateTime(subscription.currentPeriodStart, companyTimezone)} – ${
                        subscription.currentPeriodEnd
                          ? formatDateTime(subscription.currentPeriodEnd, companyTimezone)
                          : "ongoing"
                      }`
                    : "Not started"}
                </span>
              </div>
              {subscription.currentPeriodEnd ? (
                <div
                  style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}
                >
                  <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
                    Next renewal
                  </span>
                  <span style={{ fontSize: "0.85rem" }}>
                    {formatDateTime(subscription.currentPeriodEnd, companyTimezone)}
                    {daysUntilRenewal !== null
                      ? ` (${daysUntilRenewal >= 0 ? `${daysUntilRenewal} day${daysUntilRenewal === 1 ? "" : "s"} left` : "past due"})`
                      : ""}
                  </span>
                </div>
              ) : null}
              {subscription.state === "grace_period" && subscription.gracePeriodEnd ? (
                <div
                  style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}
                >
                  <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
                    Grace period ends
                  </span>
                  <span style={{ fontSize: "0.85rem", color: "#D97706" }}>
                    {formatDateTime(subscription.gracePeriodEnd, companyTimezone)}
                  </span>
                </div>
              ) : null}
              {lastPaidInvoice ? (
                <div
                  style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}
                >
                  <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
                    Last payment
                  </span>
                  <span style={{ fontSize: "0.85rem" }}>
                    {money(lastPaidInvoice.total, lastPaidInvoice.currency)} on{" "}
                    {formatDateTime(lastPaidInvoice.paidDate, companyTimezone)}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
              No subscription yet.
            </p>
          )}
        </div>

        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.6rem" }}>Usage</div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}>
            <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              Messages this billing period
            </span>
            <span style={{ fontSize: "0.85rem" }}>
              {messagesUsed}
              {messagesLimit !== null ? ` / ${messagesLimit}` : ""}
            </span>
          </div>
          <p className="dvx-muted" style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
            Aggregate usage against your plan limits. Contact your account representative for a
            detailed breakdown.
          </p>
        </div>
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.6rem" }}>Invoices</div>
        {invoices.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No invoices yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {invoices.map((invoice) => {
              const displayStatus = invoiceDisplayStatus(invoice, localToday);
              return (
                <div key={invoice.id} className="dvx-team-member-row">
                  <span className="dvx-team-member-name">
                    {invoice.invoiceNumber}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {formatDateTime(invoice.createdAt, companyTimezone)}
                      {invoice.dueDate
                        ? ` · due ${formatDateTime(invoice.dueDate, companyTimezone)}`
                        : ""}
                    </span>
                  </span>
                  <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <span className="dvx-muted" style={{ fontSize: "0.85rem" }}>
                      {money(invoice.total, invoice.currency)}
                    </span>
                    <span
                      className={`dvx-badge ${INVOICE_STATUS_BADGE[displayStatus] ?? "dvx-badge--neutral"}`}
                      style={{ fontSize: "0.7rem" }}
                    >
                      {displayStatus.replace(/_/g, " ")}
                    </span>
                    {capabilities.canPayBilling && PAYABLE_INVOICE_STATUSES.has(invoice.status) ? (
                      <MakePaymentButton invoiceId={invoice.id} />
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.6rem" }}>
          Payment history
        </div>
        {payments.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No payments recorded yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {payments.map((payment) => (
              <div key={payment.id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  {payment.method.replace(/_/g, " ")}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    {formatDateTime(payment.createdAt, companyTimezone)} · submitted by{" "}
                    {submitterLabel(payment.submittedByUserId)}
                  </span>
                </span>
                <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span className="dvx-muted" style={{ fontSize: "0.85rem" }}>
                    {money(payment.amount, payment.currency)}
                  </span>
                  <span
                    className={`dvx-badge ${PAYMENT_STATUS_BADGE[payment.status] ?? "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {payment.status}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="dvx-muted" style={{ fontSize: "0.8rem", marginTop: "0.75rem" }}>
          Use Pay Now on a due invoice above to pay online, or open a{" "}
          <Link href="/dashboard/support" className="dvx-muted">
            support request
          </Link>{" "}
          for a billing, payment, or invoice question.
        </p>
      </div>
    </div>
  );
}
