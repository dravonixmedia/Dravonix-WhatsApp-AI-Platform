import Link from "next/link";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

function maskUserId(userId: string): string {
  return `User ••${userId.slice(-4)}`;
}

export default async function AdminSupportAccessPage() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("support_access_sessions")
    .select(
      "id, company_id, platform_user_id, reason, started_at, expires_at, ended_at, companies (name)",
    )
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  const sessions = data ?? [];

  return (
    <div>
      <h1 className="dvx-page-title">Support Access</h1>
      <p className="dvx-muted">
        Time-limited sessions any active platform staff member opens to investigate a company. Not
        unrestricted: every session is bounded (max 4 hours) and audited.
      </p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        {sessions.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No support-access sessions recorded yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {sessions.map((session) => {
              const company = Array.isArray(session.companies)
                ? session.companies[0]
                : session.companies;
              const active = !session.ended_at && new Date(session.expires_at) > new Date();
              return (
                <Link
                  key={session.id}
                  href={`/admin/companies/${session.company_id}`}
                  className="dvx-team-member-row"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <span className="dvx-team-member-name">
                    {company?.name ?? "Unknown company"}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {maskUserId(session.platform_user_id)} · {session.reason}
                    </span>
                  </span>
                  <span
                    className={`dvx-badge ${active ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {session.ended_at ? "Ended" : active ? "Active" : "Expired"}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <p className="dvx-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          Start or end a support-access session from the company's page under Companies.
        </p>
      </div>
    </div>
  );
}
