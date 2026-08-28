import { adminAllowedTransitionTargets, type SubscriptionState } from "@dravonix/billing";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ACTIVE_COMPANY_ROLES, companyRoleLabel } from "../../../../lib/companyRoles.js";
import { InviteMemberForm } from "../../../dashboard/team/InviteMemberForm.js";
import {
  assignPlanAction,
  changeCompanyMemberRoleAction,
  changeSubscriptionStateAction,
  closeCompanyAction,
  deactivateCompanyMemberAction,
  endSupportAccessAction,
  reactivateCompanyAction,
  resetCompanyEntitlementAction,
  setCompanyEntitlementAction,
  startSupportAccessAction,
  suspendCompanyAction,
} from "../../../../lib/actions/admin.js";
import {
  adminAddKnowledgeSourceAction,
  adminReingestKnowledgeSourceAction,
  adminRemoveKnowledgeSourceAction,
  adminToggleKnowledgeSourceAction,
  adminUpdateCompanyAiSettingsAction,
  adminUpdateCompanyProfileAction,
  adminUpdateCompanyVoiceSettingsAction,
} from "../../../../lib/actions/adminCompanyConfig.js";
import { adminUpdateMemberDisplayNameAction } from "../../../../lib/actions/memberIdentity.js";
import { EditDisplayNameControl } from "../../../../components/EditDisplayNameControl.js";
import { InvitationActions } from "../../../../components/InvitationActions.js";
import { resolveMemberIdentity } from "../../../../lib/memberIdentity.js";
import { computeOnboardingChecklist } from "../../../../lib/onboarding.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const KNOWLEDGE_SOURCE_TYPES = [
  "company_profile",
  "service",
  "product",
  "faq",
  "pricing",
  "location",
  "policy",
  "document",
];

const KNOWLEDGE_STATUS_BADGE: Record<string, string> = {
  ready: "dvx-badge--success",
  processing: "dvx-badge--info",
  pending: "dvx-badge--neutral",
  failed: "dvx-badge--danger",
  disabled: "dvx-badge--neutral",
};

const KNOWN_FEATURE_KEYS = [
  "web_research_enabled",
  "research_requests_monthly",
  "monthly_messages",
  "monthly_voice_minutes",
  "voice_enabled",
  "staff_seats",
  "whatsapp_numbers",
  "document_knowledge_base",
  "api_access",
];

function maskUserId(userId: string): string {
  return `User ••${userId.slice(-4)}`;
}

export default async function AdminCompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select(
      "id, name, slug, status, is_demo, industry, country, timezone, default_currency, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (companyError) throw companyError;
  if (!company) notFound();

  const [
    membersResult,
    invitationsResult,
    plansResult,
    subscriptionResult,
    entitlementsResult,
    usageResult,
    whatsappAccountsResult,
    whatsappPhoneNumbersResult,
    supportSessionsResult,
    companySettingsResult,
    knowledgeSourcesResult,
    aiSettingsResult,
    voiceSettingsResult,
    knowledgeSourcesListResult,
    recentInvoicesResult,
    recentPaymentsResult,
  ] = await Promise.all([
    supabase
      .from("company_members")
      .select("id, user_id, role, is_active, created_at")
      .eq("company_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("company_invitations")
      .select("id, email, role, status, expires_at, created_at")
      .eq("company_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("plans").select("key, name").eq("is_active", true).order("name"),
    supabase
      .from("subscriptions")
      .select(
        "id, state, provider, current_period_start, current_period_end, grace_period_end, plan_versions (version, monthly_price, currency, plans (key, name))",
      )
      .eq("company_id", id)
      .maybeSingle(),
    supabase
      .from("company_entitlements")
      .select("id, feature_key, is_enabled, numeric_limit, reason, created_at")
      .eq("company_id", id)
      .order("feature_key"),
    supabase
      .from("usage_summaries")
      .select("metric, period_start, period_end, total_quantity, billable_quantity")
      .eq("company_id", id)
      .order("period_start", { ascending: false })
      .limit(20),
    supabase
      .from("whatsapp_accounts")
      .select("id, waba_id, business_name, status, last_error")
      .eq("company_id", id),
    supabase
      .from("whatsapp_phone_numbers")
      .select("id, phone_number_id, display_phone_number, status")
      .eq("company_id", id),
    supabase
      .from("support_access_sessions")
      .select("id, platform_user_id, reason, started_at, expires_at, ended_at")
      .eq("company_id", id)
      .order("started_at", { ascending: false })
      .limit(10),
    supabase
      .from("company_settings")
      .select("bot_name, welcome_message, tone, enabled_languages, default_reply_mode, ai_active")
      .eq("company_id", id)
      .maybeSingle(),
    supabase
      .from("knowledge_sources")
      .select("id", { count: "exact", head: true })
      .eq("company_id", id)
      .eq("is_enabled", true),
    supabase
      .from("ai_settings")
      .select("reply_length, unknown_answer_behavior")
      .eq("company_id", id)
      .maybeSingle(),
    supabase
      .from("voice_settings")
      .select("is_enabled, reply_mode")
      .eq("company_id", id)
      .maybeSingle(),
    supabase
      .from("knowledge_sources")
      .select("id, source_type, title, is_enabled, ingestion_status, ingestion_error, created_at")
      .eq("company_id", id)
      .order("created_at", { ascending: false }),
    // Phase 7A: read-only, top-3-only billing snapshot for this company --
    // deliberately not a repeat of /admin/invoices or /admin/payments'
    // full querying/filtering; deeper investigation links there instead.
    supabase
      .from("invoices")
      .select("id, invoice_number, kind, status, currency, total, due_date")
      .eq("company_id", id)
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("payments")
      .select("id, method, status, amount, currency, created_at")
      .eq("company_id", id)
      .order("created_at", { ascending: false })
      .limit(3),
  ]);

  const { data: memberIdentityRows } = await supabase.rpc("list_company_member_identities", {
    p_company_id: id,
  });
  type MemberIdentityRow = {
    member_id: string;
    email: string | null;
    display_name: string | null;
  };
  const memberIdentityById = new Map(
    ((memberIdentityRows ?? []) as MemberIdentityRow[]).map((row) => [
      row.member_id,
      { email: row.email, displayName: row.display_name },
    ]),
  );

  const members = membersResult.data ?? [];
  const invitations = invitationsResult.data ?? [];
  const plans = plansResult.data ?? [];
  const subscription = subscriptionResult.data as {
    id: string;
    state: string;
    provider: string;
    current_period_start: string | null;
    current_period_end: string | null;
    grace_period_end: string | null;
    plan_versions: {
      version: number;
      monthly_price: number;
      currency: string;
      plans: { key: string; name: string } | { key: string; name: string }[] | null;
    } | null;
  } | null;
  const entitlements = entitlementsResult.data ?? [];
  const usage = usageResult.data ?? [];
  const whatsappAccounts = whatsappAccountsResult.data ?? [];
  const whatsappPhoneNumbers = whatsappPhoneNumbersResult.data ?? [];
  const supportSessions = supportSessionsResult.data ?? [];

  const planRow = subscription?.plan_versions;
  const planInfo = Array.isArray(planRow?.plans) ? planRow?.plans[0] : planRow?.plans;

  const companySettings = companySettingsResult.data;
  const aiSettings = aiSettingsResult.data;
  const voiceSettings = voiceSettingsResult.data;
  const knowledgeSourcesList = knowledgeSourcesListResult.data ?? [];
  const recentInvoices = (recentInvoicesResult.data ?? []) as {
    id: string;
    invoice_number: string;
    kind: string;
    status: string;
    currency: string;
    total: number;
    due_date: string | null;
  }[];
  const recentPayments = (recentPaymentsResult.data ?? []) as {
    id: string;
    method: string;
    status: string;
    amount: number;
    currency: string;
    created_at: string;
  }[];
  const activeOwnerOrAdminCount = members.filter(
    (m) => m.is_active && (m.role === "company_owner" || m.role === "company_admin"),
  ).length;
  const whatsappConnected = whatsappAccounts.some((a) => a.status === "connected");
  const checklist = computeOnboardingChecklist({
    hasIndustry: Boolean(company.industry),
    hasCountry: Boolean(company.country),
    aiSettingsConfigured: Boolean(
      (companySettings?.bot_name && companySettings.bot_name !== "Assistant") ||
      companySettings?.welcome_message,
    ),
    enabledKnowledgeSourceCount: knowledgeSourcesResult.count ?? 0,
    activeOwnerOrAdminCount,
    hasSubscription: subscription !== null,
    whatsappConnected,
  });

  const suspendCompanyWithId = suspendCompanyAction.bind(null, id);
  const closeCompanyWithId = closeCompanyAction.bind(null, id);
  const changeCompanyMemberRoleWithId = changeCompanyMemberRoleAction.bind(null, id);
  const deactivateCompanyMemberWithId = deactivateCompanyMemberAction.bind(null, id);
  const assignPlanWithId = assignPlanAction.bind(null, id);
  const changeSubscriptionStateWithId = changeSubscriptionStateAction.bind(null, id);
  const setCompanyEntitlementWithId = setCompanyEntitlementAction.bind(null, id);
  const resetCompanyEntitlementWithId = resetCompanyEntitlementAction.bind(null, id);
  // Phase 7B: which specific admin-labeled action buttons this subscription's
  // CURRENT state actually permits -- computed from the same admin-allowed
  // edge set migration 32's admin_change_subscription_state independently
  // re-validates server-side (packages/billing's adminAllowedTransitionTargets).
  // This is convenience-only: the RPC remains authoritative regardless of
  // what renders here.
  const allowedTargets = subscription
    ? new Set(adminAllowedTransitionTargets(subscription.state as SubscriptionState))
    : new Set<string>();
  const canScheduleCancellation = allowedTargets.has("cancel_at_period_end");
  const canReverseCancellation = subscription?.state === "cancel_at_period_end";
  const canCancelImmediately = allowedTargets.has("cancelled");
  const canManuallySuspend = allowedTargets.has("manually_suspended");
  // Post-final-independent-review architecture correction: `suspended` is a
  // billing-enforcement state (reached only via an unresolved billing
  // obligation) -- reactivation must never be admin-offered for it; recovery
  // stays exclusively owned by the real payment-reconciliation path.
  // `manually_suspended` is a purely administrative state and MAY be
  // reactivated, but only while its billing period is still valid -- the RPC
  // independently re-validates current_period_end under the row lock
  // regardless of what this button shows, so this is a convenience-only
  // pre-check using data already fetched for this page (no extra query).
  const canReactivate =
    subscription?.state === "manually_suspended" &&
    subscription.current_period_end !== null &&
    new Date(subscription.current_period_end) > new Date();
  const suspendedNeedsBillingResolution = subscription?.state === "suspended";
  const startSupportAccessWithId = startSupportAccessAction.bind(null, id);
  const endSupportAccessWithId = endSupportAccessAction.bind(null, id);
  const adminUpdateCompanyProfileWithId = adminUpdateCompanyProfileAction.bind(null, id);
  const adminUpdateCompanyAiSettingsWithId = adminUpdateCompanyAiSettingsAction.bind(null, id);
  const adminUpdateCompanyVoiceSettingsWithId = adminUpdateCompanyVoiceSettingsAction.bind(
    null,
    id,
  );
  const adminAddKnowledgeSourceWithId = adminAddKnowledgeSourceAction.bind(null, id);
  const adminToggleKnowledgeSourceWithId = adminToggleKnowledgeSourceAction.bind(null, id);
  const adminRemoveKnowledgeSourceWithId = adminRemoveKnowledgeSourceAction.bind(null, id);
  const adminReingestKnowledgeSourceWithId = adminReingestKnowledgeSourceAction.bind(null, id);

  return (
    <div>
      <h1 className="dvx-page-title">{company.name}</h1>
      <p className="dvx-muted">{company.slug}</p>

      {/* Profile + lifecycle */}
      <div className="dvx-card-grid" style={{ marginTop: "1.5rem" }}>
        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
            Profile
          </div>
          <dl
            style={{
              margin: 0,
              fontSize: "0.85rem",
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "0.4rem 1rem",
            }}
          >
            <dt className="dvx-muted">Company status</dt>
            <dd style={{ margin: 0 }}>{company.status.replace(/_/g, " ")}</dd>
            <dt className="dvx-muted">Demo</dt>
            <dd style={{ margin: 0 }}>{company.is_demo ? "Yes" : "No"}</dd>
            <dt className="dvx-muted">Industry</dt>
            <dd style={{ margin: 0 }}>{company.industry ?? "Not set"}</dd>
            <dt className="dvx-muted">Country</dt>
            <dd style={{ margin: 0 }}>{company.country ?? "Not set"}</dd>
            <dt className="dvx-muted">Timezone</dt>
            <dd style={{ margin: 0 }}>{company.timezone}</dd>
            <dt className="dvx-muted">Currency</dt>
            <dd style={{ margin: 0 }}>{company.default_currency}</dd>
            <dt className="dvx-muted">Created</dt>
            <dd style={{ margin: 0 }}>{new Date(company.created_at).toLocaleDateString()}</dd>
          </dl>
          <p className="dvx-muted" style={{ fontSize: "0.72rem", margin: "0.6rem 0 0" }}>
            Company status is a separate lifecycle (onboarding/active/suspended/manually
            suspended/closed) from the subscription state shown in Plan &amp; subscription -- they
            are never the same thing and are changed by different actions.
          </p>

          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
            {company.status !== "manually_suspended" &&
            company.status !== "suspended" &&
            company.status !== "closed" ? (
              <form action={suspendCompanyWithId} style={{ display: "flex", gap: "0.4rem" }}>
                <input
                  className="dvx-input"
                  name="reason"
                  placeholder="Reason"
                  style={{ width: 160 }}
                />
                <button className="dvx-button dvx-button--secondary" type="submit">
                  Suspend
                </button>
              </form>
            ) : null}
            {company.status === "manually_suspended" || company.status === "suspended" ? (
              <form action={reactivateCompanyAction.bind(null, id)}>
                <button className="dvx-button dvx-button--secondary" type="submit">
                  Reactivate
                </button>
              </form>
            ) : null}
            {company.status !== "closed" ? (
              <form action={closeCompanyWithId} style={{ display: "flex", gap: "0.4rem" }}>
                <input
                  className="dvx-input"
                  name="reason"
                  placeholder="Reason"
                  style={{ width: 160 }}
                />
                <button className="dvx-button dvx-button--secondary" type="submit">
                  Close
                </button>
              </form>
            ) : null}
          </div>
        </div>

        {/* Subscription */}
        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
            Plan &amp; subscription
          </div>
          {subscription ? (
            <dl
              style={{
                margin: 0,
                fontSize: "0.85rem",
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "0.4rem 1rem",
              }}
            >
              <dt className="dvx-muted">Plan</dt>
              <dd style={{ margin: 0 }}>{planInfo?.name ?? "Not set"}</dd>
              <dt className="dvx-muted">Subscription state</dt>
              <dd style={{ margin: 0 }}>{subscription.state.replace(/_/g, " ")}</dd>
              <dt className="dvx-muted">Period</dt>
              <dd style={{ margin: 0 }}>
                {subscription.current_period_start
                  ? `${new Date(subscription.current_period_start).toLocaleDateString()} – ${
                      subscription.current_period_end
                        ? new Date(subscription.current_period_end).toLocaleDateString()
                        : "open"
                    }`
                  : "Not set"}
              </dd>
              {subscription.grace_period_end ? (
                <>
                  <dt className="dvx-muted">Grace period ends</dt>
                  <dd style={{ margin: 0 }}>
                    {new Date(subscription.grace_period_end).toLocaleDateString()}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
              No subscription yet.
            </p>
          )}

          <form
            action={assignPlanWithId}
            style={{ display: "flex", gap: "0.4rem", marginTop: "1rem" }}
          >
            <select className="dvx-input" name="plan_key" required>
              <option value="">Assign plan…</option>
              {plans.map((plan) => (
                <option key={plan.key} value={plan.key}>
                  {plan.name}
                </option>
              ))}
            </select>
            <button className="dvx-button dvx-button--secondary" type="submit">
              Assign
            </button>
          </form>

          {/* Phase 7B: one purpose-specific form per admin-allowed action,
              each rendered only when the subscription's CURRENT state
              actually permits it (adminAllowedTransitionTargets) -- never a
              blanket dropdown of all 10 states. Each form's action is fixed
              (a hidden new_state input), so there is exactly one thing each
              button can do; admin_change_subscription_state (migration 32)
              independently re-validates the transition regardless, but the
              UI itself never offers an invalid one. Every action requires
              navigating to its own labeled form and clicking its own
              distinct submit button -- that explicit, separated gesture is
              this codebase's existing confirmation convention (matching
              Suspend/Close above), not a JS confirm() dialog or a modal. */}
          {subscription && canScheduleCancellation ? (
            <form
              action={changeSubscriptionStateWithId}
              style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}
            >
              <input type="hidden" name="new_state" value="cancel_at_period_end" />
              <input
                className="dvx-input"
                name="reason"
                placeholder="Reason (optional)"
                style={{ width: 160 }}
              />
              <button className="dvx-button dvx-button--secondary" type="submit">
                Schedule cancellation
              </button>
            </form>
          ) : null}

          {subscription && canReverseCancellation ? (
            <form
              action={changeSubscriptionStateWithId}
              style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}
            >
              <input type="hidden" name="new_state" value="active" />
              <input
                className="dvx-input"
                name="reason"
                placeholder="Reason (optional)"
                style={{ width: 160 }}
              />
              <button className="dvx-button dvx-button--secondary" type="submit">
                Reverse scheduled cancellation
              </button>
            </form>
          ) : null}

          {subscription && canReactivate ? (
            <form
              action={changeSubscriptionStateWithId}
              style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}
            >
              <input type="hidden" name="new_state" value="active" />
              <input
                className="dvx-input"
                name="reason"
                placeholder="Reason (optional)"
                style={{ width: 160 }}
              />
              <button className="dvx-button dvx-button--secondary" type="submit">
                Reactivate
              </button>
            </form>
          ) : null}

          {suspendedNeedsBillingResolution ? (
            <p className="dvx-muted" style={{ fontSize: "0.78rem", marginTop: "0.5rem" }}>
              Billing recovery required before reactivation.
            </p>
          ) : null}

          {subscription && canManuallySuspend ? (
            <form
              action={changeSubscriptionStateWithId}
              style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}
            >
              <input type="hidden" name="new_state" value="manually_suspended" />
              <input
                className="dvx-input"
                name="reason"
                placeholder="Reason (required)"
                required
                style={{ width: 160 }}
              />
              <button className="dvx-button dvx-button--secondary" type="submit">
                Manually suspend
              </button>
            </form>
          ) : null}

          {subscription && canCancelImmediately ? (
            <form
              action={changeSubscriptionStateWithId}
              style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}
            >
              <input type="hidden" name="new_state" value="cancelled" />
              <input
                className="dvx-input"
                name="reason"
                placeholder="Reason (required)"
                required
                style={{ width: 160 }}
              />
              <button className="dvx-button dvx-button--secondary" type="submit">
                Cancel immediately
              </button>
            </form>
          ) : null}
        </div>

        {/* Billing -- Phase 7A. A compact, read-only snapshot only; the
            full querying/filtering lives on /admin/invoices, /admin/payments
            and /admin/billing so this page never becomes a second billing
            dashboard (no repository/business logic is duplicated here). */}
        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
            Billing
          </div>
          <div style={{ marginBottom: "0.75rem" }}>
            <div className="dvx-muted" style={{ fontSize: "0.72rem", marginBottom: "0.3rem" }}>
              Recent invoices
            </div>
            {recentInvoices.length === 0 ? (
              <p className="dvx-muted" style={{ fontSize: "0.82rem", margin: 0 }}>
                No invoices yet.
              </p>
            ) : (
              recentInvoices.map((invoice) => (
                <div key={invoice.id} style={{ fontSize: "0.82rem", marginBottom: "0.25rem" }}>
                  {invoice.invoice_number} · {invoice.currency} {invoice.total.toFixed(2)} ·{" "}
                  <span className="dvx-muted">{invoice.status.replace(/_/g, " ")}</span>
                </div>
              ))
            )}
          </div>
          <div style={{ marginBottom: "0.75rem" }}>
            <div className="dvx-muted" style={{ fontSize: "0.72rem", marginBottom: "0.3rem" }}>
              Recent payments
            </div>
            {recentPayments.length === 0 ? (
              <p className="dvx-muted" style={{ fontSize: "0.82rem", margin: 0 }}>
                No payments yet.
              </p>
            ) : (
              recentPayments.map((payment) => (
                <div key={payment.id} style={{ fontSize: "0.82rem", marginBottom: "0.25rem" }}>
                  {payment.currency} {payment.amount.toFixed(2)} (
                  {payment.method.replace(/_/g, " ")}) ·{" "}
                  <span className="dvx-muted">{payment.status}</span>
                </div>
              ))
            )}
          </div>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", fontSize: "0.8rem" }}>
            <Link href={`/admin/invoices?company=${encodeURIComponent(company.name)}`}>
              All invoices →
            </Link>
            <Link href={`/admin/payments?company=${encodeURIComponent(company.name)}`}>
              All payments →
            </Link>
            <Link href="/admin/billing">Billing operations →</Link>
          </div>
        </div>
      </div>

      {/* Company Profile edit -- Client Dashboard Permission Hardening
          (migration 00000000000022) made the client-facing Company Settings
          page read-only; this is the one place company profile/timezone/
          currency can actually be changed now. */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Company profile
        </div>
        <form
          action={adminUpdateCompanyProfileWithId}
          style={{ display: "flex", flexDirection: "column", gap: "0.6rem", maxWidth: 480 }}
        >
          <label style={{ fontSize: "0.8rem" }}>
            Company name
            <input
              className="dvx-input"
              name="name"
              defaultValue={company.name}
              required
              style={{ marginTop: "0.3rem" }}
            />
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Industry
            <input
              className="dvx-input"
              name="industry"
              defaultValue={company.industry ?? ""}
              style={{ marginTop: "0.3rem" }}
            />
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Country
            <input
              className="dvx-input"
              name="country"
              defaultValue={company.country ?? ""}
              style={{ marginTop: "0.3rem" }}
            />
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Timezone (IANA identifier)
            <input
              className="dvx-input"
              name="timezone"
              defaultValue={company.timezone}
              style={{ marginTop: "0.3rem" }}
            />
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Currency (ISO 4217)
            <input
              className="dvx-input"
              name="default_currency"
              defaultValue={company.default_currency}
              style={{ marginTop: "0.3rem" }}
            />
          </label>
          <button
            className="dvx-button dvx-button--secondary"
            type="submit"
            style={{ alignSelf: "flex-start" }}
          >
            Save company profile
          </button>
        </form>
      </div>

      {/* Onboarding & Readiness */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.75rem",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Onboarding &amp; readiness</span>
          <span
            className={`dvx-badge ${checklist.readyToActivate ? "dvx-badge--success" : "dvx-badge--neutral"}`}
            style={{ fontSize: "0.7rem" }}
          >
            {checklist.readyToActivate ? "Ready to activate" : "In progress"}
          </span>
        </div>
        <div className="dvx-team-member-list">
          {checklist.steps.map((step) => (
            <div key={step.key} className="dvx-team-member-row">
              <span className="dvx-team-member-name">
                {step.label}
                <span className="dvx-muted" style={{ display: "block", fontSize: "0.78rem" }}>
                  {step.detail}
                </span>
              </span>
              <span
                className={`dvx-badge ${step.complete ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                style={{ fontSize: "0.7rem" }}
              >
                {step.complete ? "Complete" : "Pending"}
              </span>
            </div>
          ))}
        </div>
        <p className="dvx-muted" style={{ fontSize: "0.75rem", marginTop: "0.75rem" }}>
          This reflects real database state. Activation stays a separate, explicit action -- the
          checklist being complete does not change company.status by itself.
        </p>
      </div>

      {/* Members */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Users &amp; roles
        </div>
        {members.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No members yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {members.map((member) => {
              const memberIdentity = memberIdentityById.get(member.id);
              const identity = resolveMemberIdentity({
                name: memberIdentity?.displayName ?? null,
                email: memberIdentity?.email ?? null,
                userId: member.user_id,
              });
              const adminUpdateDisplayNameWithMember = adminUpdateMemberDisplayNameAction.bind(
                null,
                id,
                member.user_id,
              );
              return (
                <div key={member.id} className="dvx-team-member-row">
                  <span className="dvx-team-member-name">
                    <span style={{ display: "block" }}>{identity.primary}</span>
                    {identity.secondary ? (
                      <span
                        className="dvx-muted"
                        style={{ display: "block", fontSize: "0.78rem", fontWeight: 400 }}
                      >
                        {identity.secondary}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className="dvx-team-member-badges"
                    style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                  >
                    <span className="dvx-badge dvx-badge--neutral" style={{ fontSize: "0.7rem" }}>
                      {companyRoleLabel(member.role)}
                    </span>
                    <span
                      className={`dvx-badge ${member.is_active ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                      style={{ fontSize: "0.7rem" }}
                    >
                      {member.is_active ? "Active" : "Disabled"}
                    </span>
                    <EditDisplayNameControl
                      currentDisplayName={memberIdentity?.displayName ?? null}
                      onSave={adminUpdateDisplayNameWithMember}
                    />
                    {member.is_active ? (
                      <>
                        <form
                          action={changeCompanyMemberRoleWithId}
                          style={{ display: "flex", gap: "0.3rem" }}
                        >
                          <input type="hidden" name="member_id" value={member.id} />
                          <select
                            className="dvx-input"
                            name="new_role"
                            defaultValue={member.role}
                            style={{ fontSize: "0.78rem", padding: "0.3rem 0.5rem" }}
                          >
                            {/* member.role may be a legacy/dormant value not in
                                ACTIVE_COMPANY_ROLES (e.g. a pre-Phase-2 row this
                                migration didn't touch in some other
                                environment) -- included so the <select>'s
                                current value is always a real option, never
                                silently coerced to the first one. */}
                            {((ACTIVE_COMPANY_ROLES as readonly string[]).includes(member.role)
                              ? ACTIVE_COMPANY_ROLES
                              : [member.role, ...ACTIVE_COMPANY_ROLES]
                            ).map((r) => (
                              <option key={r} value={r}>
                                {companyRoleLabel(r)}
                              </option>
                            ))}
                          </select>
                          <button
                            className="dvx-button dvx-button--secondary"
                            type="submit"
                            style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                          >
                            Change role
                          </button>
                        </form>
                        <form action={deactivateCompanyMemberWithId}>
                          <input type="hidden" name="member_id" value={member.id} />
                          <button
                            className="dvx-button dvx-button--secondary"
                            type="submit"
                            style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                          >
                            Deactivate
                          </button>
                        </form>
                      </>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Invite a new customer */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Invite a new customer
        </div>
        <p
          className="dvx-muted"
          style={{ fontSize: "0.8rem", marginTop: 0, marginBottom: "0.75rem" }}
        >
          The invited person does not need an existing DRAIVA account -- an email is sent to them
          with a link to create one and accept in a single step. If email delivery isn&apos;t
          configured yet, a manual-copy link is shown instead.
        </p>
        <InviteMemberForm companyId={id} defaultRole="company_owner" roles={ACTIVE_COMPANY_ROLES} />
      </div>

      {/* Invitations */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Invitations
        </div>
        {invitations.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No invitations yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {invitations.map((invitation) => (
              <div key={invitation.id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  {invitation.email}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    {companyRoleLabel(invitation.role)} · invited{" "}
                    {new Date(invitation.created_at).toLocaleDateString()} · expires{" "}
                    {new Date(invitation.expires_at).toLocaleDateString()}
                  </span>
                </span>
                <span
                  className="dvx-team-member-badges"
                  style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                >
                  <span
                    className={`dvx-badge ${invitation.status === "pending" ? "dvx-badge--warning" : invitation.status === "accepted" ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {invitation.status}
                  </span>
                  {invitation.status === "pending" ? (
                    <InvitationActions invitationId={invitation.id} />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* DRAIVA AI Settings -- Client Dashboard Permission Hardening
          (migration 00000000000022) made /dashboard/ai-settings read-only;
          this is the one place AI/voice configuration can actually be
          changed now, over the same company_settings/ai_settings/
          voice_settings schema (no duplicate settings system). */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          DRAIVA AI settings
        </div>
        <form
          action={adminUpdateCompanyAiSettingsWithId}
          style={{ display: "flex", flexDirection: "column", gap: "0.6rem", maxWidth: 480 }}
        >
          <label style={{ fontSize: "0.8rem" }}>
            Assistant name
            <input
              className="dvx-input"
              name="bot_name"
              defaultValue={companySettings?.bot_name ?? "Assistant"}
              style={{ marginTop: "0.3rem" }}
            />
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Welcome message
            <textarea
              className="dvx-input"
              name="welcome_message"
              defaultValue={companySettings?.welcome_message ?? ""}
              rows={2}
              style={{ marginTop: "0.3rem", resize: "vertical" }}
            />
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Tone
            <select
              className="dvx-input"
              name="tone"
              defaultValue={companySettings?.tone ?? "friendly_professional"}
              style={{ marginTop: "0.3rem" }}
            >
              <option value="friendly_professional">Friendly &amp; professional</option>
              <option value="formal">Formal</option>
              <option value="casual">Casual</option>
            </select>
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Supported languages (comma-separated, e.g. en, ml)
            <input
              className="dvx-input"
              name="enabled_languages"
              defaultValue={(companySettings?.enabled_languages ?? ["en"]).join(", ")}
              style={{ marginTop: "0.3rem" }}
            />
          </label>
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}
          >
            <input
              type="checkbox"
              name="ai_active"
              defaultChecked={companySettings?.ai_active ?? true}
            />
            AI replies are active
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Default reply mode
            <select
              className="dvx-input"
              name="default_reply_mode"
              defaultValue={companySettings?.default_reply_mode ?? "auto"}
              style={{ marginTop: "0.3rem" }}
            >
              <option value="auto">Auto</option>
              <option value="text_only">Text only</option>
              <option value="voice_only">Voice only</option>
              <option value="text_and_voice">Text and voice</option>
            </select>
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Reply length
            <select
              className="dvx-input"
              name="reply_length"
              defaultValue={aiSettings?.reply_length ?? "medium"}
              style={{ marginTop: "0.3rem" }}
            >
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="long">Long</option>
            </select>
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            When the assistant doesn&apos;t know an answer
            <select
              className="dvx-input"
              name="unknown_answer_behavior"
              defaultValue={aiSettings?.unknown_answer_behavior ?? "escalate"}
              style={{ marginTop: "0.3rem" }}
            >
              <option value="escalate">Hand over to a human</option>
              <option value="static_fallback">Use a fallback message</option>
              <option value="best_effort">Best-effort answer</option>
            </select>
          </label>
          <button
            className="dvx-button dvx-button--secondary"
            type="submit"
            style={{ alignSelf: "flex-start" }}
          >
            Save AI settings
          </button>
        </form>

        <form
          action={adminUpdateCompanyVoiceSettingsWithId}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
            maxWidth: 480,
            marginTop: "1.25rem",
            paddingTop: "1rem",
            borderTop: "1px solid var(--border-default)",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Voice</div>
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}
          >
            <input
              type="checkbox"
              name="voice_enabled"
              defaultChecked={voiceSettings?.is_enabled ?? true}
            />
            Voice replies enabled
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Voice reply mode
            <select
              className="dvx-input"
              name="voice_reply_mode"
              defaultValue={voiceSettings?.reply_mode ?? "auto"}
              style={{ marginTop: "0.3rem" }}
            >
              <option value="auto">Auto</option>
              <option value="text_only">Text only</option>
              <option value="voice_only">Voice only</option>
              <option value="text_and_voice">Text and voice</option>
            </select>
          </label>
          <button
            className="dvx-button dvx-button--secondary"
            type="submit"
            style={{ alignSelf: "flex-start" }}
          >
            Save voice settings
          </button>
        </form>
      </div>

      {/* Knowledge Base -- Client Dashboard Permission Hardening (migration
          00000000000022) made /dashboard/knowledge read-only; this is the
          one place sources can be added/enabled/disabled/removed/edited now,
          over the same knowledge_sources/knowledge_chunks schema (no
          parallel knowledge system). P2 knowledge ingestion (migration 34)
          made "Add source"/"Edit content" real, transactional ingestion --
          content is cleaned, chunked, and committed via ingest_knowledge_source,
          with ingestion_status/ingestion_error genuinely reflecting whether
          that succeeded, instead of the prior single-raw-chunk write that
          always left the source cosmetically 'ready'. Still text/FAQ paste
          only -- no file upload, no PDF/DOCX, per the P2 audit's launch
          scope. */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Knowledge base
        </div>
        {knowledgeSourcesList.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No knowledge sources yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {knowledgeSourcesList.map((source) => {
              return (
                <div key={source.id} className="dvx-team-member-row">
                  <span className="dvx-team-member-name">
                    {source.title}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {source.source_type.replace(/_/g, " ")}
                    </span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span
                      className={`dvx-badge ${KNOWLEDGE_STATUS_BADGE[source.ingestion_status] ?? "dvx-badge--neutral"}`}
                      style={{ fontSize: "0.7rem" }}
                      title={source.ingestion_error ?? undefined}
                    >
                      {source.ingestion_status.replace(/_/g, " ")}
                    </span>
                    <span
                      className={`dvx-badge ${source.is_enabled ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                      style={{ fontSize: "0.7rem" }}
                    >
                      {source.is_enabled ? "Enabled" : "Disabled"}
                    </span>
                    <form action={adminToggleKnowledgeSourceWithId}>
                      <input type="hidden" name="source_id" value={source.id} />
                      <input
                        type="hidden"
                        name="next_enabled"
                        value={(!source.is_enabled).toString()}
                      />
                      <button
                        className="dvx-button dvx-button--secondary"
                        type="submit"
                        style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                      >
                        {source.is_enabled ? "Disable" : "Enable"}
                      </button>
                    </form>
                    <form action={adminRemoveKnowledgeSourceWithId}>
                      <input type="hidden" name="source_id" value={source.id} />
                      <button
                        className="dvx-button dvx-button--secondary"
                        type="submit"
                        style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                      >
                        Remove
                      </button>
                    </form>
                  </span>
                  <details style={{ width: "100%", marginTop: "0.4rem" }}>
                    <summary
                      className="dvx-muted"
                      style={{ fontSize: "0.78rem", cursor: "pointer" }}
                    >
                      Edit content
                    </summary>
                    <form
                      action={adminReingestKnowledgeSourceWithId}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.4rem",
                        marginTop: "0.4rem",
                      }}
                    >
                      <input type="hidden" name="source_id" value={source.id} />
                      <input type="hidden" name="source_type" value={source.source_type} />
                      <textarea
                        className="dvx-input"
                        name="content"
                        placeholder="Replace this source's content -- committing re-ingests it atomically; a failed attempt never removes the current content"
                        rows={3}
                        style={{ resize: "vertical" }}
                      />
                      <button
                        className="dvx-button dvx-button--secondary"
                        type="submit"
                        style={{ fontSize: "0.75rem", alignSelf: "flex-start" }}
                      >
                        Save content
                      </button>
                    </form>
                  </details>
                </div>
              );
            })}
          </div>
        )}

        <form
          action={adminAddKnowledgeSourceWithId}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
            marginTop: "1rem",
            paddingTop: "1rem",
            borderTop: "1px solid var(--border-default)",
          }}
        >
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <input
              className="dvx-input"
              name="title"
              placeholder="Title"
              required
              style={{ flex: 1, minWidth: 180 }}
            />
            <select
              className="dvx-input"
              name="source_type"
              defaultValue="faq"
              style={{ maxWidth: 200 }}
            >
              {KNOWLEDGE_SOURCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="dvx-input"
            name="content"
            placeholder="Content the assistant should know (optional -- can add later)"
            rows={3}
            style={{ resize: "vertical" }}
          />
          <button className="dvx-button" type="submit" style={{ alignSelf: "flex-start" }}>
            Add source
          </button>
        </form>
      </div>

      {/* Entitlements */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Entitlement overrides
        </div>
        {entitlements.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No company-specific overrides -- plan defaults apply.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {entitlements.map((entitlement) => (
              <div key={entitlement.id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  {entitlement.feature_key}
                  {entitlement.numeric_limit !== null ? (
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      limit: {entitlement.numeric_limit}
                    </span>
                  ) : null}
                </span>
                <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span
                    className={`dvx-badge ${entitlement.is_enabled ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {entitlement.is_enabled ? "Enabled" : "Disabled"}
                  </span>
                  {/* Phase 7B: restores plan-default behavior by deleting
                      this exact override row (admin_reset_company_entitlement,
                      migration 32) -- never edits plan_entitlements, never
                      copies a plan default into company_entitlements. */}
                  <form action={resetCompanyEntitlementWithId}>
                    <input type="hidden" name="feature_key" value={entitlement.feature_key} />
                    <button
                      className="dvx-button dvx-button--secondary"
                      type="submit"
                      style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem" }}
                    >
                      Reset to plan default
                    </button>
                  </form>
                </span>
              </div>
            ))}
          </div>
        )}

        <form
          action={setCompanyEntitlementWithId}
          style={{
            display: "flex",
            gap: "0.5rem",
            marginTop: "1rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <input
            className="dvx-input"
            name="feature_key"
            placeholder="Feature key"
            list="known-feature-keys"
            required
            style={{ maxWidth: 220 }}
          />
          <datalist id="known-feature-keys">
            {KNOWN_FEATURE_KEYS.map((key) => (
              <option key={key} value={key} />
            ))}
          </datalist>
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}
          >
            <input type="checkbox" name="is_enabled" defaultChecked /> Enabled
          </label>
          <input
            className="dvx-input"
            name="numeric_limit"
            type="number"
            placeholder="Numeric limit"
            style={{ maxWidth: 140 }}
          />
          <input
            className="dvx-input"
            name="reason"
            placeholder="Reason"
            style={{ maxWidth: 200 }}
          />
          <button className="dvx-button" type="submit">
            Set override
          </button>
        </form>
      </div>

      {/* Usage */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Usage (recent periods)
        </div>
        {usage.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No usage recorded yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {usage.map((row, index) => (
              <div key={index} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  {row.metric.replace(/_/g, " ")}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    {row.period_start} – {row.period_end}
                  </span>
                </span>
                <span style={{ fontSize: "0.85rem" }}>{row.total_quantity}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* WhatsApp */}
      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          WhatsApp connection
        </div>
        {whatsappAccounts.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No WhatsApp Business Account connected.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {whatsappAccounts.map((account) => (
              <div key={account.id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  {account.business_name ?? "Business account"}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    WABA {account.waba_id}
                  </span>
                </span>
                <span className="dvx-badge dvx-badge--neutral" style={{ fontSize: "0.7rem" }}>
                  {account.status.replace(/_/g, " ")}
                </span>
              </div>
            ))}
          </div>
        )}
        {whatsappPhoneNumbers.length > 0 ? (
          <div className="dvx-team-member-list" style={{ marginTop: "0.5rem" }}>
            {whatsappPhoneNumbers.map((phone) => (
              <div key={phone.id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  {phone.display_phone_number ?? phone.phone_number_id}
                </span>
                <span className="dvx-badge dvx-badge--neutral" style={{ fontSize: "0.7rem" }}>
                  {phone.status.replace(/_/g, " ")}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ marginTop: "1rem" }}>
          <button
            className="dvx-button dvx-button--secondary"
            type="button"
            disabled
            style={{ opacity: 0.6, cursor: "not-allowed" }}
          >
            Meta WhatsApp onboarding — Integration in progress
          </button>
        </div>
      </div>

      {/* Support access */}
      <div className="dvx-card" style={{ marginTop: "1.5rem", marginBottom: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Support access sessions
        </div>
        {supportSessions.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No support-access sessions recorded.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {supportSessions.map((session) => {
              const active = !session.ended_at && new Date(session.expires_at) > new Date();
              return (
                <div key={session.id} className="dvx-team-member-row">
                  <span className="dvx-team-member-name">
                    {maskUserId(session.platform_user_id)}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {session.reason}
                    </span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span
                      className={`dvx-badge ${active ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                      style={{ fontSize: "0.7rem" }}
                    >
                      {session.ended_at ? "Ended" : active ? "Active" : "Expired"}
                    </span>
                    {active ? (
                      <form action={endSupportAccessWithId}>
                        <input type="hidden" name="session_id" value={session.id} />
                        <button
                          className="dvx-button dvx-button--secondary"
                          type="submit"
                          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                        >
                          End
                        </button>
                      </form>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <form
          action={startSupportAccessWithId}
          style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}
        >
          <input className="dvx-input" name="reason" placeholder="Reason for access" required />
          <input
            className="dvx-input"
            name="duration_minutes"
            type="number"
            placeholder="Minutes"
            defaultValue={60}
            style={{ maxWidth: 120 }}
          />
          <button className="dvx-button" type="submit">
            Start support access
          </button>
        </form>
      </div>
    </div>
  );
}
