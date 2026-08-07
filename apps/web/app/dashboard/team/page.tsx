import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

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

/**
 * Masks a company_members.user_id down to its last 4 characters -- the only
 * per-member identifier this dashboard can safely show for a teammate other
 * than the signed-in caller. There is no public-schema profiles/email table
 * mirroring auth.users in this codebase, so a real name or email for anyone
 * but the caller genuinely isn't resolvable without a new, unapproved data
 * path -- this shows real derived data instead of fabricating a name.
 */
function maskMemberId(userId: string): string {
  return `Member ••${userId.slice(-4)}`;
}

/**
 * Team Settings -- people and access only (Team Members list, roles,
 * active/inactive status). Split out of the former combined /dashboard/settings
 * page into its own real route: that page previously served both "Team
 * Settings" and "Company Settings" sidebar links, which both pointed at the
 * exact same page component (different URL anchors only), so the two
 * sidebar destinations looked identical to a user. This page now owns team
 * content exclusively; Company Settings (app/dashboard/settings/page.tsx)
 * owns company-configuration content exclusively.
 *
 * Only renders actions the current backend actually supports: there is no
 * invite/role-change/revoke RPC in this codebase yet (confirmed by
 * inspection of lib/actions and the migrations), so none are shown here --
 * this is a read view of real company_members data, same as before.
 */
export default async function TeamSettingsPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);

  if (!capabilities.canManageTeam) {
    return (
      <div className="dvx-card" style={{ maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Team Settings</h1>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Your role does not have permission to manage team members.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("company_members")
    .select("id, user_id, role, is_active, created_at")
    .eq("company_id", session.activeCompanyId)
    .order("created_at", { ascending: true });

  const members = data ?? [];
  const activeMembers = members.filter((m) => m.is_active);

  return (
    <div>
      <h1 className="dvx-page-title">Team Settings</h1>
      <p className="dvx-muted">Manage team members, roles and access to this workspace.</p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Team members
        </div>
        {members.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No team members found.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {members.map((member) => (
              <div key={member.id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  {member.id === session.activeMemberId
                    ? (session.email ?? "You")
                    : maskMemberId(member.user_id)}
                  {member.id === session.activeMemberId ? (
                    <span className="dvx-muted"> (You)</span>
                  ) : null}
                </span>
                <span className="dvx-team-member-badges">
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
        <div
          style={{
            marginTop: "0.75rem",
            paddingTop: "0.75rem",
            borderTop: "1px solid var(--border-default)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "1rem",
              padding: "0.4rem 0",
            }}
          >
            <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              Active members
            </span>
            <span style={{ fontSize: "0.85rem" }}>{activeMembers.length}</span>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "1rem",
              padding: "0.4rem 0",
            }}
          >
            <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              Plan staff limit
            </span>
            <span className="dvx-muted" style={{ fontSize: "0.85rem" }}>
              Not configured
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
