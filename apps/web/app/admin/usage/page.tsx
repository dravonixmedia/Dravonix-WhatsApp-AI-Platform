import { createServerSupabaseClient } from "../../../lib/supabase/server.js";
import {
  accumulateCompanyUsage,
  formatTtsCharacters,
  formatVoiceDuration,
  type CompanyUsage,
} from "../../../lib/usageDisplay.js";

export const dynamic = "force-dynamic";

export default async function AdminUsagePage() {
  const supabase = await createServerSupabaseClient();

  const usageResult = await supabase
    .from("usage_summaries")
    .select("company_id, metric, total_quantity, period_start, companies (name)")
    .order("period_start", { ascending: false })
    .limit(500);
  if (usageResult.error) throw usageResult.error;

  let byCompany = new Map<string, CompanyUsage>();
  for (const row of usageResult.data ?? []) {
    const company = Array.isArray(row.companies) ? row.companies[0] : row.companies;
    byCompany = accumulateCompanyUsage(byCompany, {
      companyId: row.company_id as string,
      companyName: company?.name ?? null,
      metric: row.metric,
      totalQuantity: row.total_quantity,
    });
  }
  const companies = Array.from(byCompany.values()).sort((a, b) => b.messages - a.messages);

  const totalMessages = companies.reduce((sum, c) => sum + c.messages, 0);
  const totalTtsCharacters = companies.reduce((sum, c) => sum + c.ttsCharacters, 0);
  const anyVoiceDurationMetered = companies.some((c) => c.voiceDurationMetered);
  const totalVoiceDurationSeconds = companies.reduce((sum, c) => sum + c.voiceDurationSeconds, 0);

  return (
    <div>
      <h1 className="dvx-page-title">Usage</h1>
      <p className="dvx-muted">
        Platform-wide and per-company usage, sourced from usage_summaries.
      </p>

      <div className="dvx-kpi-grid" style={{ marginTop: "1.5rem" }}>
        <div className="dvx-card dvx-kpi-card">
          <span className="dvx-kpi-value">{totalMessages}</span>
          <span className="dvx-kpi-label">WhatsApp messages (recent periods)</span>
        </div>
        <div className="dvx-card dvx-kpi-card">
          <span className="dvx-kpi-value">{totalTtsCharacters}</span>
          <span className="dvx-kpi-label">Text-to-speech characters (recent periods)</span>
        </div>
        <div className="dvx-card dvx-kpi-card">
          <span className="dvx-kpi-value">
            {anyVoiceDurationMetered ? totalVoiceDurationSeconds : "--"}
          </span>
          <span className="dvx-kpi-label">
            {anyVoiceDurationMetered
              ? "Voice duration, seconds (recent periods)"
              : "Voice duration (not metered)"}
          </span>
        </div>
        <div className="dvx-card dvx-kpi-card">
          <span className="dvx-kpi-value">--</span>
          <span className="dvx-kpi-label">Research usage (not yet metered)</span>
        </div>
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          By company
        </div>
        {companies.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No usage recorded yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {companies.map((c) => (
              <div key={c.companyId} className="dvx-team-member-row">
                <span className="dvx-team-member-name">{c.companyName}</span>
                <span className="dvx-muted" style={{ fontSize: "0.82rem" }}>
                  {c.messages} messages · {formatTtsCharacters(c)} · {formatVoiceDuration(c)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
        <p className="dvx-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          Research usage has no dedicated usage_events metric yet -- the DRAIVA Research pipeline
          does not currently write usage_events rows. The research_requests_monthly entitlement key
          exists and can be overridden per company under Entitlements, but a real count against it
          requires instrumenting the research pipeline separately.
        </p>
      </div>

      {!anyVoiceDurationMetered && (
        <div className="dvx-card" style={{ marginTop: "1.5rem", maxWidth: 640 }}>
          <p className="dvx-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            Voice duration (speech-to-text seconds, generated-voice seconds) is not currently
            metered -- no usage_events rows exist for these metrics yet, so this is not a verified
            zero. Text-to-speech usage above is tracked by character count, which is a genuinely
            instrumented, separate unit and must not be combined with duration.
          </p>
        </div>
      )}
    </div>
  );
}
