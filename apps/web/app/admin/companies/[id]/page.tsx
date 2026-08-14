import { notFound } from "next/navigation";
import {
  assignPlanAction,
  changeCompanyMemberRoleAction,
  changeSubscriptionStateAction,
  closeCompanyAction,
  deactivateCompanyMemberAction,
  endSupportAccessAction,
  inviteCompanyMemberAction,
  reactivateCompanyAction,
  setCompanyEntitlementAction,
  startSupportAccessAction,
  suspendCompanyAction,
} from "../../../../lib/actions/admin.js";
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
    plansResult,
    subscriptionResult,
    entitlementsResult,
    usageResult,
    whatsappAccountsResult,
    whatsappPhoneNumbersResult,
    supportSessionsResult,
  ] = await Promise.all([
    supabase
      .from("company_members")
      .select("id, user_id, role, is_active, created_at")
      .eq("company_id", id)
      .order("created_at", { ascending: true }),
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
  ]);

  const members = membersResult.data ?? [];
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

  const suspendCompanyWithId = suspendCompanyAction.bind(null, id);
  const closeCompanyWithId = closeCompanyAction.bind(null, id);
  const inviteCompanyMemberWithId = inviteCompanyMemberAction.bind(null, id);
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

        <form
          action={inviteCompanyMemberWithId}
          style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}
        >
          <input
            className="dvx-input"
            name="email"
            type="email"
            placeholder="Existing Auth user's email"
            required
          />
          <select
            className="dvx-input"
            name="role"
            defaultValue="company_owner"
            style={{ maxWidth: 200 }}
          >
            {COMPANY_ROLES.map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <button className="dvx-button" type="submit">
            Invite
          </button>
        </form>
        <p className="dvx-muted" style={{ fontSize: "0.75rem", marginTop: "0.5rem" }}>
          The invited person must already have a DRAIVA Auth account -- this does not send an email
          yet.
        </p>
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
