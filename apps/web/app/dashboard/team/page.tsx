import {
  companyDeactivateMemberAction,
  companyReactivateMemberAction,
  companyChangeMemberRoleAction,
} from "../../../lib/actions/invitations.js";
import { updateMemberDisplayNameAction } from "../../../lib/actions/memberIdentity.js";
import { CLIENT_ASSIGNABLE_ROLES, companyRoleLabel } from "../../../lib/companyRoles.js";
import { EditDisplayNameControl } from "../../../components/EditDisplayNameControl.js";
import { InvitationActions } from "../../../components/InvitationActions.js";
import { resolveMemberIdentity } from "../../../lib/memberIdentity.js";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import { InviteMemberForm } from "./InviteMemberForm.js";

export const dynamic = "force-dynamic";

/**
 * Team Settings -- Phase 2 role model expansion (migration 24) revives
 * team.manage for company_owner/company_admin (Client Dashboard Permission
 * Hardening, migration 22, had moved all of this to Super Admin-only). Owner
 * and Admin get full invite/role-change/deactivate-reactivate controls
 * again, now with server-side owner protection (company_change_member_role/
 * company_deactivate_member reject touching the current company_owner no
 * matter what this page renders -- see migration 24's comments). Manager/
 * Team Leader/Sales Person hold team.view but not team.manage, so they see
 * the same member list read-only. Company Accounts holds neither
 * permission and never reaches this page at all -- both the sidebar link
 * (dashboard/layout.tsx, gated on canViewTeam) and the guard below agree.
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

  const { data: invitationsData } = capabilities.canManageTeam
    ? await supabase
        .from("company_invitations")
        .select("id, email, role, status, expires_at, created_at")
        .eq("company_id", session.activeCompanyId)
        .order("created_at", { ascending: false })
        .limit(20)
    : { data: null };
  const invitations = invitationsData ?? [];

  return (
    <div>
      <h1 className="dvx-page-title">Team Settings</h1>
      <p className="dvx-muted">
        {capabilities.canManageTeam
          ? "Invite teammates, manage roles, and activate or deactivate members."
          : "View team members and their access."}
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
              const isOwner = member.role === "company_owner";
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
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                      justifyContent: "flex-end",
                    }}
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
                    {capabilities.canManageDisplayNames ? (
                      <EditDisplayNameControl
                        currentDisplayName={memberIdentity?.displayName ?? null}
                        onSave={updateDisplayNameWithMember}
                      />
                    ) : null}
                    {/* Owner protection: the current company_owner row never
                        gets a role-change/deactivate control on this page --
                        company_change_member_role/company_deactivate_member
                        would reject either action anyway, but hiding the
                        control here keeps the UI honest about what a client
                        can actually do (RPC rules remain authoritative). */}
                    {capabilities.canManageTeam && member.is_active && !isOwner ? (
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
                          {CLIENT_ASSIGNABLE_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {companyRoleLabel(role)}
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
                    ) : null}
                    {capabilities.canManageTeam && !isOwner ? (
                      member.is_active ? (
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
                      ) : (
                        <form action={companyReactivateMemberAction}>
                          <input type="hidden" name="member_id" value={member.id} />
                          <button
                            className="dvx-button dvx-button--secondary"
                            type="submit"
                            style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                          >
                            Reactivate
                          </button>
                        </form>
                      )
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

      {capabilities.canManageTeam ? (
        <>
          <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
              Invite a teammate
            </div>
            <p
              className="dvx-muted"
              style={{ fontSize: "0.8rem", marginTop: 0, marginBottom: "0.75rem" }}
            >
              The invited person does not need an existing DRAIVA account -- an email is sent to
              them with a link to create one and accept in a single step. Owner cannot be assigned
              here; ownership changes go through Dravonix.
            </p>
            <InviteMemberForm companyId={session.activeCompanyId} defaultRole="manager" />
          </div>

          <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
            <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
              Pending invitations
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
                      <span
                        className="dvx-muted"
                        style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                      >
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
        </>
      ) : null}
    </div>
  );
}
