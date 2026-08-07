import Link from "next/link";
import { maskPhoneNumber } from "@dravonix/handover";
import { listSupportedCurrencies } from "../../../lib/currencyList.js";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { listSupportedTimezones } from "../../../lib/timezoneList.js";
import { CurrencySelect } from "./CurrencySelect.js";
import { TimezoneCombobox } from "./TimezoneCombobox.js";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  company_owner: "Owner",
  company_admin: "Admin",
  manager: "Manager",
  agent: "Agent",
  knowledge_editor: "Knowledge Editor",
  billing_viewer: "Billing Viewer",
  viewer: "Viewer",
};

function SettingsRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div
      style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.4rem 0" }}
    >
      <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
        {label}
      </span>
      <span
        style={{ fontSize: "0.85rem", textAlign: "right" }}
        className={value ? undefined : "dvx-muted"}
      >
        {value ?? "Not provided"}
      </span>
    </div>
  );
}

function SectionCard({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="dvx-card" style={{ scrollMarginTop: "1.5rem" }}>
      <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.5rem" }}>{title}</div>
      {children}
    </div>
  );
}

/**
 * Masks a company_members.user_id down to its last 4 characters -- the only
 * per-member identifier this dashboard can safely show for a teammate other
 * than the signed-in caller. There is no public-schema profiles/email table
 * mirroring auth.users in this codebase (confirmed by grep), so a real name
 * or email for anyone but the caller genuinely isn't resolvable without a
 * new, unapproved data path -- this shows real derived data instead of
 * fabricating a name.
 */
function maskMemberId(userId: string): string {
  return `Member ••${userId.slice(-4)}`;
}

export default async function SettingsPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  const canViewAnySection =
    capabilities.canManageSettings || capabilities.canManageTeam || capabilities.canManageBilling;

  if (!canViewAnySection) {
    return (
      <div className="dvx-card" style={{ maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Settings</h1>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Your role does not have permission to view account settings.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();

  const [companyResult, membersResult, whatsappAccountResult] = await Promise.all([
    capabilities.canManageSettings
      ? supabase
          .from("companies")
          .select("name, status, timezone, default_currency, created_at")
          .eq("id", session.activeCompanyId)
          .single()
      : Promise.resolve({ data: null }),
    capabilities.canManageTeam
      ? supabase
          .from("company_members")
          .select("id, user_id, role, is_active, created_at")
          .eq("company_id", session.activeCompanyId)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: null }),
    capabilities.canManageWhatsapp
      ? supabase
          .from("whatsapp_accounts")
          .select("status, whatsapp_phone_numbers (display_phone_number)")
          .eq("company_id", session.activeCompanyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const company = companyResult.data;
  const members = capabilities.canManageTeam ? (membersResult.data ?? []) : [];
  const activeMembers = members.filter((m) => m.is_active);
  const whatsappAccount = whatsappAccountResult.data as {
    status: string;
    whatsapp_phone_numbers: { display_phone_number: string | null }[] | null;
  } | null;
  const whatsappPhone = whatsappAccount?.whatsapp_phone_numbers?.[0]?.display_phone_number ?? null;

  // The only real, non-fabricated "admin email" this session can safely
  // resolve without a new profiles/email lookup: the caller's own email,
  // and only when their own role genuinely is an account-admin role.
  const adminEmail =
    company && (session.activeRole === "company_owner" || session.activeRole === "company_admin")
      ? session.email
      : null;

  return (
    <div>
      <h1 className="dvx-page-title">Settings</h1>
      <p className="dvx-muted">Company account details for this account.</p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "1rem",
          marginTop: "1.5rem",
        }}
      >
        {capabilities.canManageSettings ? (
          <SectionCard id="company-details" title="Company details">
            <SettingsRow label="Company name" value={company?.name ?? null} />
            <SettingsRow
              label="Account status"
              value={company?.status ? company.status.replace(/_/g, " ") : null}
            />
            <SettingsRow label="Admin email" value={adminEmail} />
            <TimezoneCombobox
              label="Business Timezone"
              helpText="Used for business hours, operational dates and company-local scheduling context."
              initialValue={company?.timezone ?? ""}
              options={listSupportedTimezones()}
              saveLabel="Save Timezone"
            />
            <CurrencySelect
              label="Business Currency"
              helpText="Used for financial values, billing displays and business-level monetary settings."
              initialValue={company?.default_currency ?? "INR"}
              currencies={listSupportedCurrencies()}
              saveLabel="Save Currency"
            />
            <SettingsRow
              label="Created"
              value={company?.created_at ? new Date(company.created_at).toLocaleDateString() : null}
            />
          </SectionCard>
        ) : null}

        {capabilities.canManageTeam ? (
          <SectionCard id="team-members" title="Team members">
            {members.length === 0 ? (
              <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
                No team members found.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {members.map((member) => (
                  <div
                    key={member.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "0.75rem",
                      padding: "0.4rem 0",
                      borderBottom: "1px solid var(--border-default)",
                    }}
                  >
                    <span style={{ fontSize: "0.85rem" }}>
                      {member.id === session.activeMemberId
                        ? (session.email ?? "You")
                        : maskMemberId(member.user_id)}
                      {member.id === session.activeMemberId ? (
                        <span className="dvx-muted"> (You)</span>
                      ) : null}
                    </span>
                    <span style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
                      <span className="dvx-badge dvx-badge--neutral" style={{ fontSize: "0.7rem" }}>
                        {ROLE_LABELS[member.role] ?? member.role}
                      </span>
                      <span
                        className={`dvx-badge ${member.is_active ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                        style={{ fontSize: "0.7rem" }}
                      >
                        {member.is_active ? "Active" : "Disabled"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: "0.75rem" }}>
              <SettingsRow label="Active members" value={String(activeMembers.length)} />
              <SettingsRow label="Plan staff limit" value="Not configured" />
            </div>
          </SectionCard>
        ) : null}

        {capabilities.canManageBilling ? (
          <SectionCard title="Subscription status">
            <SettingsRow label="Current plan" value="Not configured" />
            <SettingsRow label="Subscription status" value="Not active" />
            <p className="dvx-muted" style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
              Subscription management will be available soon.
            </p>
          </SectionCard>
        ) : null}

        {capabilities.canManageWhatsapp ? (
          <SectionCard title="WhatsApp connection">
            <SettingsRow
              label="Connection status"
              value={whatsappAccount?.status ? whatsappAccount.status.replace(/_/g, " ") : null}
            />
            <SettingsRow
              label="Connected number"
              value={whatsappPhone ? maskPhoneNumber(whatsappPhone) : null}
            />
            <div style={{ marginTop: "0.75rem" }}>
              <Link
                href="/dashboard/settings/whatsapp"
                className="dvx-button dvx-button--secondary"
                style={{ fontSize: "0.8rem", textDecoration: "none" }}
              >
                View WhatsApp connection
              </Link>
            </div>
          </SectionCard>
        ) : null}
      </div>
    </div>
  );
}
