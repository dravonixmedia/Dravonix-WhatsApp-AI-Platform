import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const MESSAGE_METRICS = new Set([
  "whatsapp_inbound_messages",
  "whatsapp_outbound_messages",
  "whatsapp_template_messages",
]);
const VOICE_METRICS = new Set([
  "speech_to_text_seconds",
  "generated_voice_seconds",
  "text_to_speech_characters",
]);

interface CompanyUsage {
  companyId: string;
  companyName: string;
  messages: number;
  voice: number;
}

export default async function AdminUsagePage() {
  const supabase = await createServerSupabaseClient();

  const usageResult = await supabase
    .from("usage_summaries")
    .select("company_id, metric, total_quantity, period_start, companies (name)")
    .order("period_start", { ascending: false })
    .limit(500);
  if (usageResult.error) throw usageResult.error;

  const byCompany = new Map<string, CompanyUsage>();
  for (const row of usageResult.data ?? []) {
    const company = Array.isArray(row.companies) ? row.companies[0] : row.companies;
    const key = row.company_id as string;
    const existing = byCompany.get(key) ?? {
      companyId: key,
      companyName: company?.name ?? "Unknown company",
      messages: 0,
      voice: 0,
    };
    if (MESSAGE_METRICS.has(row.metric)) existing.messages += Number(row.total_quantity ?? 0);
    if (VOICE_METRICS.has(row.metric)) existing.voice += Number(row.total_quantity ?? 0);
    byCompany.set(key, existing);
  }
  const companies = Array.from(byCompany.values()).sort((a, b) => b.messages - a.messages);

  const totalMessages = companies.reduce((sum, c) => sum + c.messages, 0);
  const totalVoice = companies.reduce((sum, c) => sum + c.voice, 0);

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
          <span className="dvx-kpi-value">{totalVoice}</span>
          <span className="dvx-kpi-label">Voice seconds (recent periods)</span>
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
                  {c.messages} messages · {c.voice}s voice
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
    </div>
  );
}
