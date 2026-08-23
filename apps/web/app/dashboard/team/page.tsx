import { updateMemberDisplayNameAction } from "../../../lib/actions/memberIdentity.js";
import { EditDisplayNameControl } from "../../../components/EditDisplayNameControl.js";
import { resolveMemberIdentity } from "../../../lib/memberIdentity.js";
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
 * Team Settings -- client Dashboard Permission Hardening (migration
 * 00000000000022): the client Team page is now view + display-name-edit
 * only. Inviting teammates, resending/revoking invitations, changing
 * roles, and activating/deactivating members are Dravonix-only now,
 * managed from Super Admin -> Companies -> [Company] -- team.manage was
 * revoked from every client role at the database level, so those RPCs
 * (create_company_invitation, admin_resend_company_invitation,
 * admin_revoke_company_invitation, company_change_member_role,
 * company_deactivate_member) are no longer reachable by any client
 * session even if this page still rendered forms for them; removing the
 * forms here just keeps the UI honest about what a client can actually do.
 * Editing an existing member's display name remains available to
 * team.view + team.display_name.manage holders (company_owner/
 * company_admin), via the same shared update_user_display_name RPC/
 * EditDisplayNameControl used elsewhere.
 */
export default async function TeamSettingsPage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);

  if (!capabilities.canViewTeam) {
    return (
      <div className="dvx-card" style={{ maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Team Settings</h1>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Your role does not have permission to view the team.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();
  const { data: membersData, error } = await supabase
    .from("company_members")
    .select("id, user_id, role, is_active, created_at")
    .eq("company_id", session.activeCompanyId)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const { data: memberIdentityRows } = await supabase.rpc("list_company_member_identities", {
    p_company_id: session.activeCompanyId,
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

  const members = membersData ?? [];
  const activeMembers = members.filter((m) => m.is_active);

  return (
    <div>
      <h1 className="dvx-page-title">Team Settings</h1>
      <p className="dvx-muted">
        View team members and their access. Inviting, roles, and activation are managed by Dravonix.
      </p>

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
            {members.map((member) => {
              const isSelf = member.id === session.activeMemberId;
              const memberIdentity = memberIdentityById.get(member.id);
              const identity = resolveMemberIdentity({
                name: memberIdentity?.displayName ?? null,
                email: (isSelf ? session.email : memberIdentity?.email) ?? null,
                userId: member.user_id,
              });
              const updateDisplayNameWithMember = updateMemberDisplayNameAction.bind(
                null,
                member.user_id,
              );
              return (
                <div key={member.id} className="dvx-team-member-row">
                  <span className="dvx-team-member-name">
                    <span style={{ display: "block" }}>
                      {identity.primary}
                      {isSelf ? <span className="dvx-muted"> (You)</span> : null}
                    </span>
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
                      {ROLE_LABELS[member.role] ?? member.role}
                    </span>
                    <span
                      className={`dvx-badge ${member.is_active ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                      style={{ fontSize: "0.7rem" }}
                    >
                      {member.is_active ? "Active" : "Disabled"}
                    </span>
                    {capabilities.canManageDisplayNames ? (
                      <EditDisplayNameControl
                        currentDisplayName={memberIdentity?.displayName ?? null}
                        onSave={updateDisplayNameWithMember}
                      />
                    ) : null}
                  </span>
                </div>
              );
            })}
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
