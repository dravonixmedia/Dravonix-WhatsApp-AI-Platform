import Link from "next/link";
import { createCompanyAction } from "../../../lib/actions/admin.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  onboarding: "dvx-badge--info",
  active: "dvx-badge--success",
  suspended: "dvx-badge--warning",
  manually_suspended: "dvx-badge--warning",
  closed: "dvx-badge--neutral",
};

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  is_demo: boolean;
  industry: string | null;
  country: string | null;
  created_at: string;
}

export default async function AdminCompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const { q, status } = await searchParams;
  const supabase = await createServerSupabaseClient();

  let query = supabase
    .from("companies")
    .select("id, name, slug, status, is_demo, industry, country, created_at")
    .order("created_at", { ascending: false });

  if (q) query = query.ilike("name", `%${q}%`);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) throw error;
  const companies = (data ?? []) as CompanyRow[];

  return (
    <div>
      <h1 className="dvx-page-title">Companies</h1>
      <p className="dvx-muted">Every DRAIVA tenant, across production and demo/test companies.</p>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Create company
        </div>
        <form
          action={createCompanyAction}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "0.75rem",
          }}
        >
          <input className="dvx-input" name="name" placeholder="Company name" required />
          <input className="dvx-input" name="industry" placeholder="Industry (optional)" />
          <input className="dvx-input" name="country" placeholder="Country (optional)" />
          <input
            className="dvx-input"
            name="timezone"
            placeholder="Timezone"
            defaultValue="Asia/Kolkata"
          />
          <input className="dvx-input" name="currency" placeholder="Currency" defaultValue="INR" />
          <label
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}
          >
            <input type="checkbox" name="is_demo" /> Demo / test company
          </label>
          <button
            className="dvx-button"
            type="submit"
            style={{ gridColumn: "1 / -1", justifySelf: "start" }}
          >
            Create company
          </button>
        </form>
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <form style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem" }}>
          <input
            className="dvx-input"
            name="q"
            placeholder="Search by name"
            defaultValue={q ?? ""}
          />
          <select
            className="dvx-input"
            name="status"
            defaultValue={status ?? ""}
            style={{ maxWidth: 220 }}
          >
            <option value="">All statuses</option>
            <option value="onboarding">Onboarding</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="manually_suspended">Manually suspended</option>
            <option value="closed">Closed</option>
          </select>
          <button className="dvx-button dvx-button--secondary" type="submit">
            Filter
          </button>
        </form>

        {companies.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No companies match this filter.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {companies.map((company) => (
              <Link
                key={company.id}
                href={`/admin/companies/${company.id}`}
                className="dvx-team-member-row"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <span className="dvx-team-member-name">
                  {company.name}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    {[company.industry, company.country].filter(Boolean).join(" · ") ||
                      company.slug}
                  </span>
                </span>
                <span className="dvx-team-member-badges">
                  {company.is_demo ? (
                    <span className="dvx-badge dvx-badge--neutral" style={{ fontSize: "0.7rem" }}>
                      Demo
                    </span>
                  ) : null}
                  <span
                    className={`dvx-badge ${STATUS_BADGE[company.status] ?? "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {company.status.replace(/_/g, " ")}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
