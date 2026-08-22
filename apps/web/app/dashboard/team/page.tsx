import {
  companyChangeMemberRoleAction,
  companyDeactivateMemberAction,
  resendCompanyInvitationAction,
  revokeCompanyInvitationAction,
} from "../../../lib/actions/invitations.js";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { InviteMemberForm } from "./InviteMemberForm.js";

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

const COMPANY_ROLES = Object.keys(ROLE_LABELS);

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
 * Team Settings -- people and access. Invite (migration 18's
 * create_company_invitation), pending-invitation management (resend/revoke),
 * role changes and deactivation now go through real, team.manage-gated RPCs
 * (company_change_member_role/company_deactivate_member) -- this page no
 * longer only reads company_members.
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
  const [membersResult, invitationsResult] = await Promise.all([
    supabase
      .from("company_members")
      .select("id, user_id, role, is_active, created_at")
      .eq("company_id", session.activeCompanyId)
      .order("created_at", { ascending: true }),
    supabase
      .from("company_invitations")
      .select("id, email, role, status, expires_at, created_at")
      .eq("company_id", session.activeCompanyId)
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
  ]);

  const members = membersResult.data ?? [];
  const invitations = invitationsResult.data ?? [];
  const activeMembers = members.filter((m) => m.is_active);

  return (
    <div>
      <h1 className="dvx-page-title">Team Settings</h1>
      <p className="dvx-muted">Manage team members, roles and access to this workspace.</p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Invite a teammate
        </div>
        <InviteMemberForm companyId={session.activeCompanyId} />
      </div>

      {invitations.length > 0 ? (
        <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
            Pending invitations
          </div>
          <div className="dvx-team-member-list">
            {invitations.map((invitation) => (
              <div key={invitation.id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  Invite sent to {invitation.email}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    {ROLE_LABELS[invitation.role] ?? invitation.role} · {invitation.status} ·
                    expires {new Date(invitation.expires_at).toLocaleDateString()}
                  </span>
                </span>
                <span style={{ display: "flex", gap: "0.4rem" }}>
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
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

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
                <span
                  className="dvx-team-member-badges"
                  style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                >
                  <span
                    className={`dvx-badge ${member.is_active ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {member.is_active ? "Active" : "Disabled"}
                  </span>
                  {member.is_active && member.id !== session.activeMemberId ? (
                    <>
                      <form
                        action={companyChangeMemberRoleAction}
                        style={{ display: "flex", gap: "0.3rem" }}
                      >
                        <input type="hidden" name="member_id" value={member.id} />
                        <select
                          className="dvx-input"
                          name="new_role"
                          defaultValue={member.role}
                          style={{ fontSize: "0.78rem", padding: "0.3rem 0.5rem" }}
                        >
                          {COMPANY_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role]}
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
                      <form action={companyDeactivateMemberAction}>
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
                  ) : (
                    <span className="dvx-badge dvx-badge--neutral" style={{ fontSize: "0.7rem" }}>
                      {ROLE_LABELS[member.role] ?? member.role}
                    </span>
                  )}
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
        </div>
      </div>
    </div>
  );
}
