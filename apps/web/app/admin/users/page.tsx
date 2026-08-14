import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

function maskUserId(userId: string): string {
  return `User ••${userId.slice(-4)}`;
}

export default async function AdminUsersPage() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("platform_members")
    .select("user_id, role, is_active, created_at")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const members = data ?? [];

  return (
    <div>
      <h1 className="dvx-page-title">Users &amp; Roles</h1>
      <p className="dvx-muted">
        Dravonix platform staff -- accounts with a platform_members record.
      </p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        {members.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No platform staff members found.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {members.map((member) => (
              <div key={member.user_id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">{maskUserId(member.user_id)}</span>
                <span className="dvx-team-member-badges">
                  <span className="dvx-badge dvx-badge--brand" style={{ fontSize: "0.7rem" }}>
                    {member.role.replace(/_/g, " ")}
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
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <p className="dvx-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          Company-level users and roles (owners, admins, agents, etc.) are managed per-company under
          each company's page in Companies.
        </p>
      </div>
    </div>
  );
}
