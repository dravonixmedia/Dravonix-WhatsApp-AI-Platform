import Link from "next/link";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

export default async function AdminEntitlementsPage() {
  const supabase = await createServerSupabaseClient();

  const [overridesResult, planDefaultsResult] = await Promise.all([
    supabase
      .from("company_entitlements")
      .select("id, company_id, feature_key, is_enabled, numeric_limit, companies (name)")
      .order("feature_key"),
    supabase
      .from("plan_entitlements")
      .select("feature_key, is_enabled, numeric_limit, plan_versions (is_current, plans (name))")
      .order("feature_key"),
  ]);
  if (overridesResult.error) throw overridesResult.error;
  if (planDefaultsResult.error) throw planDefaultsResult.error;

  const overrides = overridesResult.data ?? [];
  const planDefaults = (planDefaultsResult.data ?? []).filter((row) => {
    const pv = Array.isArray(row.plan_versions) ? row.plan_versions[0] : row.plan_versions;
    return pv?.is_current;
  });

  return (
    <div>
      <h1 className="dvx-page-title">Entitlements</h1>
      <p className="dvx-muted">Plan defaults and per-company overrides for every feature key.</p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Plan defaults
        </div>
        <div className="dvx-team-member-list">
          {planDefaults.map((row, index) => {
            const pv = Array.isArray(row.plan_versions) ? row.plan_versions[0] : row.plan_versions;
            const plan = Array.isArray(pv?.plans) ? pv?.plans[0] : pv?.plans;
            return (
              <div key={index} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  {row.feature_key}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    {plan?.name}
                  </span>
                </span>
                <span className="dvx-team-member-badges">
                  {row.numeric_limit !== null ? (
                    <span className="dvx-muted" style={{ fontSize: "0.78rem" }}>
                      limit: {row.numeric_limit}
                    </span>
                  ) : null}
                  <span
                    className={`dvx-badge ${row.is_enabled ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {row.is_enabled ? "Enabled" : "Disabled"}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Company overrides
        </div>
        {overrides.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No company has an entitlement override yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {overrides.map((row) => {
              const company = Array.isArray(row.companies) ? row.companies[0] : row.companies;
              return (
                <Link
                  key={row.id}
                  href={`/admin/companies/${row.company_id}`}
                  className="dvx-team-member-row"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <span className="dvx-team-member-name">
                    {company?.name ?? "Unknown company"}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {row.feature_key}
                    </span>
                  </span>
                  <span
                    className={`dvx-badge ${row.is_enabled ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {row.is_enabled ? "Enabled" : "Disabled"}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
