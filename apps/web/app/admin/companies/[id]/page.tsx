import { notFound } from "next/navigation";
import { InviteMemberForm } from "../../../dashboard/team/InviteMemberForm.js";
import {
  assignPlanAction,
  changeCompanyMemberRoleAction,
  changeSubscriptionStateAction,
  closeCompanyAction,
  deactivateCompanyMemberAction,
  endSupportAccessAction,
  reactivateCompanyAction,
  setCompanyEntitlementAction,
  startSupportAccessAction,
  suspendCompanyAction,
} from "../../../../lib/actions/admin.js";
import {
  resendCompanyInvitationAction,
  revokeCompanyInvitationAction,
} from "../../../../lib/actions/invitations.js";
import { computeOnboardingChecklist } from "../../../../lib/onboarding.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const COMPANY_ROLES = [
  "company_owner",
  "company_admin",
  "manager",
  "agent",
  "knowledge_editor",
  "billing_viewer",
  "viewer",
];

const SUBSCRIPTION_STATES = [
  "onboarding",
  "trial",
  "active",
  "payment_due",
  "grace_period",
  "suspended",
  "cancel_at_period_end",
  "cancelled",
  "manually_suspended",
  "closed",
];

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
        "id, state, provider, current_period_start, current_period_end, plan_versions (version, monthly_price, currency, plans (key, name))",
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
      .select("bot_name, welcome_message")
      .eq("company_id", id)
      .maybeSingle(),
    supabase
      .from("knowledge_sources")
      .select("id", { count: "exact", head: true })
      .eq("company_id", id)
      .eq("is_enabled", true),
  ]);

  const members = membersResult.data ?? [];
  const invitations = invitationsResult.data ?? [];
  const plans = plansResult.data ?? [];
  const subscription = subscriptionResult.data as {
    id: string;
    state: string;
    provider: string;
    current_period_start: string | null;
    current_period_end: string | null;
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
  const startSupportAccessWithId = startSupportAccessAction.bind(null, id);
  const endSupportAccessWithId = endSupportAccessAction.bind(null, id);

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
            <dt className="dvx-muted">Status</dt>
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
              <dt className="dvx-muted">State</dt>
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

          {subscription ? (
            <form
              action={changeSubscriptionStateWithId}
              style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}
            >
              <select className="dvx-input" name="new_state" required>
                <option value="">Change state…</option>
                {SUBSCRIPTION_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <input
                className="dvx-input"
                name="reason"
                placeholder="Reason"
                style={{ width: 140 }}
              />
              <button className="dvx-button dvx-button--secondary" type="submit">
                Apply
              </button>
            </form>
          ) : null}
        </div>
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
            {members.map((member) => (
              <div key={member.id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">{maskUserId(member.user_id)}</span>
                <span
                  className="dvx-team-member-badges"
                  style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                >
                  <span className="dvx-badge dvx-badge--neutral" style={{ fontSize: "0.7rem" }}>
                    {member.role.replace(/_/g, " ")}
                  </span>
                  <span
                    className={`dvx-badge ${member.is_active ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {member.is_active ? "Active" : "Disabled"}
                  </span>
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
                          {COMPANY_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r.replace(/_/g, " ")}
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
            ))}
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
          The invited person does not need an existing DRAIVA account -- the link below lets them
          create one and accept in a single step. No email is sent automatically yet; copy the link
          and deliver it out of band.
        </p>
        <InviteMemberForm companyId={id} defaultRole="company_owner" />
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
                    {invitation.role.replace(/_/g, " ")} · invited{" "}
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
                    <>
                      <form
                        action={async () => {
                          "use server";
                          await resendCompanyInvitationAction(invitation.id);
                        }}
                      >
                        <button
                          className="dvx-button dvx-button--secondary"
                          type="submit"
                          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                        >
                          Resend
                        </button>
                      </form>
                      <form action={revokeCompanyInvitationAction.bind(null, invitation.id)}>
                        <button
                          className="dvx-button dvx-button--secondary"
                          type="submit"
                          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                        >
                          Revoke
                        </button>
                      </form>
                    </>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
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
                <span
                  className={`dvx-badge ${entitlement.is_enabled ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                  style={{ fontSize: "0.7rem" }}
                >
                  {entitlement.is_enabled ? "Enabled" : "Disabled"}
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
