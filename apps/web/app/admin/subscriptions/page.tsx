import Link from "next/link";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const STATE_BADGE: Record<string, string> = {
  active: "dvx-badge--success",
  trial: "dvx-badge--info",
  onboarding: "dvx-badge--info",
  payment_due: "dvx-badge--warning",
  grace_period: "dvx-badge--warning",
  suspended: "dvx-badge--danger",
  manually_suspended: "dvx-badge--danger",
  cancel_at_period_end: "dvx-badge--warning",
  cancelled: "dvx-badge--neutral",
  closed: "dvx-badge--neutral",
};

export default async function AdminSubscriptionsPage() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("id, state, company_id, companies (name), plan_versions (plans (name))")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const subscriptions = data ?? [];

  return (
    <div>
      <h1 className="dvx-page-title">Subscriptions</h1>
      <p className="dvx-muted">Every company's current subscription state.</p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        {subscriptions.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No subscriptions yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {subscriptions.map((sub) => {
              const company = Array.isArray(sub.companies) ? sub.companies[0] : sub.companies;
              const planVersion = Array.isArray(sub.plan_versions)
                ? sub.plan_versions[0]
                : sub.plan_versions;
              const plan = Array.isArray(planVersion?.plans)
                ? planVersion?.plans[0]
                : planVersion?.plans;
              return (
                <Link
                  key={sub.id}
                  href={`/admin/companies/${sub.company_id}`}
                  className="dvx-team-member-row"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <span className="dvx-team-member-name">
                    {company?.name ?? "Unknown company"}
                    <span
                      className="dvx-muted"
                      style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}
                    >
                      {plan?.name ?? "No plan"}
                    </span>
                  </span>
                  <span
                    className={`dvx-badge ${STATE_BADGE[sub.state] ?? "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {sub.state.replace(/_/g, " ")}
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
