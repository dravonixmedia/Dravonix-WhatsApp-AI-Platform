import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

function maskUserId(userId: string | null): string {
  if (!userId) return "System";
  return `User ••${userId.slice(-4)}`;
}

export default async function AdminAuditPage() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("audit_logs")
    .select(
      "id, action, actor_user_id, actor_type, target_type, target_id, company_id, created_at, companies (name)",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const logs = data ?? [];

  return (
    <div>
      <h1 className="dvx-page-title">Audit Logs</h1>
      <p className="dvx-muted">The most recent 100 platform-wide audit events.</p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        {logs.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No audit events yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {logs.map((log) => {
              const company = Array.isArray(log.companies) ? log.companies[0] : log.companies;
              return (
                <div key={log.id} className="dvx-team-member-row">
                  <span className="dvx-team-member-name">
                    {log.action}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {company?.name ?? "—"} · {maskUserId(log.actor_user_id)}
                      {log.target_type ? ` · ${log.target_type}` : ""}
                    </span>
                  </span>
                  <span className="dvx-muted" style={{ fontSize: "0.78rem" }}>
                    {new Date(log.created_at).toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
