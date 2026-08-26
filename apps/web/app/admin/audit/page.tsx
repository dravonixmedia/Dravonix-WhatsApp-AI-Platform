import {
  buildMemberIdentityByUserId,
  resolveMemberIdentity,
  type CompanyMemberIdentityRow,
} from "../../../lib/memberIdentity.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

/**
 * Resolves an audit-log actor to a human-friendly label using the same
 * company-scoped list_company_member_identities/resolveMemberIdentity
 * architecture as Support & Requests and Team Settings -- never a
 * competing precedence. `null` means a genuine system-generated event
 * (actor_user_id itself is null); a real user id that can't be resolved
 * (a platform-staff actor, who is not necessarily a company_members row of
 * the event's company, or a deleted/inactive member) falls back to the
 * same masked "User ••xxxx" format resolveMemberIdentity already produces
 * for an unresolvable identity elsewhere -- it is never mislabeled "System".
 */
function resolveActorLabel(
  actorUserId: string | null,
  memberIdentityByUserId: Map<string, { displayName: string | null }>,
): string {
  if (!actorUserId) return "System";
  const identity = memberIdentityByUserId.get(actorUserId);
  return resolveMemberIdentity({
    name: identity?.displayName ?? null,
    email: null,
    userId: actorUserId,
  }).primary;
}

const RESULT_LIMIT = 200;

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string; action?: string; from?: string; to?: string }>;
}) {
  const { company, action, from, to } = await searchParams;
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("audit_logs")
    .select(
      "id, action, actor_user_id, actor_type, target_type, target_id, company_id, created_at, companies (name)",
    )
    .order("created_at", { ascending: false })
    .limit(RESULT_LIMIT);

  if (action) query = query.ilike("action", `%${action}%`);
  // Postgres date (no time component) is treated as that day's start in UTC;
  // "to" is made exclusive of the following day so a single day range (e.g.
  // from=to=2026-08-26) includes every event recorded that day.
  if (from) query = query.gte("created_at", from);
  if (to) {
    const toExclusive = new Date(`${to}T00:00:00.000Z`);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
    query = query.lt("created_at", toExclusive.toISOString());
  }

  if (company) {
    const { data: matchingCompanies, error: companyError } = await supabase
      .from("companies")
      .select("id")
      .ilike("name", `%${company}%`);
    if (companyError) throw companyError;
    const companyIds = (matchingCompanies ?? []).map((c) => c.id);
    query = query.in(
      "company_id",
      companyIds.length > 0 ? companyIds : ["00000000-0000-0000-0000-000000000000"],
    );
  }

  const { data, error } = await query;
  if (error) throw error;
  const logs = data ?? [];

  // Batched, not N+1: one list_company_member_identities call per distinct
  // company_id among the fetched rows (typically far fewer than 100), not
  // one per row. is_platform_staff() (enforced by this route's own
  // super_admin gate in app/admin/layout.tsx) lets the RPC resolve any
  // company's members regardless of the caller's own membership.
  const companyIds = [...new Set(logs.map((log) => log.company_id).filter((id) => id !== null))];
  const identityResults = await Promise.all(
    companyIds.map((companyId) =>
      supabase
        .rpc("list_company_member_identities", { p_company_id: companyId })
        .then(({ data: rows }) => (rows ?? []) as CompanyMemberIdentityRow[]),
    ),
  );
  const memberIdentityByUserId = buildMemberIdentityByUserId(identityResults.flat());

  return (
    <div>
      <h1 className="dvx-page-title">Audit Logs</h1>
      <p className="dvx-muted">
        The most recent {RESULT_LIMIT} platform-wide audit events matching this filter.
      </p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <form style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
          <input
            className="dvx-input"
            name="company"
            placeholder="Search by company name"
            defaultValue={company ?? ""}
          />
          <input
            className="dvx-input"
            name="action"
            placeholder="Search by action (e.g. suspend)"
            defaultValue={action ?? ""}
          />
          <input className="dvx-input" type="date" name="from" defaultValue={from ?? ""} />
          <input className="dvx-input" type="date" name="to" defaultValue={to ?? ""} />
          <button className="dvx-button dvx-button--secondary" type="submit">
            Filter
          </button>
        </form>

        {logs.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No audit events match this filter.
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
                      {company?.name ?? "—"} ·{" "}
                      {resolveActorLabel(log.actor_user_id, memberIdentityByUserId)}
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
