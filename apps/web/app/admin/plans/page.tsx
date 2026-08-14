import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

export default async function AdminPlansPage() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("plans")
    .select(
      "id, key, name, description, is_active, plan_versions (version, monthly_price, currency, is_current)",
    )
    .order("name");
  if (error) throw error;
  const plans = data ?? [];

  return (
    <div>
      <h1 className="dvx-page-title">Plans</h1>
      <p className="dvx-muted">Every billing plan available to assign to a company.</p>

      <div className="dvx-card-grid" style={{ marginTop: "1.5rem" }}>
        {plans.map((plan) => {
          const versions = (plan.plan_versions ?? []) as {
            version: number;
            monthly_price: number;
            currency: string;
            is_current: boolean;
          }[];
          const current = versions.find((v) => v.is_current) ?? versions[0];
          return (
            <div key={plan.id} className="dvx-card">
              <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>{plan.name}</div>
              <p className="dvx-muted" style={{ fontSize: "0.82rem", margin: "0.3rem 0 0.75rem" }}>
                {plan.description}
              </p>
              {current ? (
                <div style={{ fontSize: "0.9rem" }}>
                  {current.currency} {current.monthly_price} / month
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    v{current.version}
                  </span>
                </div>
              ) : (
                <p className="dvx-muted" style={{ fontSize: "0.82rem" }}>
                  No published version.
                </p>
              )}
              <span
                className={`dvx-badge ${plan.is_active ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                style={{ fontSize: "0.7rem", marginTop: "0.75rem", display: "inline-block" }}
              >
                {plan.is_active ? "Active" : "Retired"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <p className="dvx-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          To assign a plan to a company, open the company under Companies and use the Plan &amp;
          subscription panel.
        </p>
      </div>
    </div>
  );
}
