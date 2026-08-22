import {
  addKnowledgeSourceAction,
  removeKnowledgeSourceAction,
  toggleKnowledgeSourceAction,
} from "../../../lib/actions/knowledge.js";
import { getDashboardCapabilities } from "../../../lib/permissions.js";
import { getDashboardSession } from "../../../lib/session.js";
import { createServerSupabaseClient } from "../../../lib/supabase/server.js";

export const dynamic = "force-dynamic";

const SOURCE_TYPES = [
  "company_profile",
  "service",
  "product",
  "faq",
  "pricing",
  "location",
  "policy",
  "document",
];

const STATUS_BADGE: Record<string, string> = {
  ready: "dvx-badge--success",
  processing: "dvx-badge--info",
  pending: "dvx-badge--neutral",
  failed: "dvx-badge--danger",
  disabled: "dvx-badge--neutral",
};

/**
 * Real Knowledge Base management: list/add/enable-disable/remove sources
 * over the existing knowledge_sources/knowledge_chunks schema -- no parallel
 * knowledge system. Company-scoped throughout (every query/action is scoped
 * to session.activeCompanyId, never a client-supplied id).
 */
export default async function KnowledgePage() {
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewKnowledge) {
    return (
      <div className="dvx-card" style={{ maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Knowledge Base</h1>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Your role does not have permission to view the knowledge base.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("knowledge_sources")
    .select("id, source_type, title, is_enabled, ingestion_status, ingestion_error, created_at")
    .eq("company_id", session.activeCompanyId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const sources = data ?? [];

  return (
    <div>
      <h1 className="dvx-page-title">Knowledge Base</h1>
      <p className="dvx-muted">
        The information your AI assistant draws on when answering customers.
      </p>

      {capabilities.canManageKnowledge ? (
        <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.75rem" }}>
            Add a knowledge source
          </div>
          <form
            action={addKnowledgeSourceAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
          >
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <input
                className="dvx-input"
                name="title"
                placeholder="Title"
                required
                style={{ flex: 1, minWidth: 180 }}
              />
              <select
                className="dvx-input"
                name="source_type"
                defaultValue="faq"
                style={{ maxWidth: 200 }}
              >
                {SOURCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              className="dvx-input"
              name="content"
              placeholder="Content the assistant should know (optional -- can add later)"
              rows={3}
              style={{ resize: "vertical" }}
            />
            <button className="dvx-button" type="submit" style={{ alignSelf: "flex-start" }}>
              Add source
            </button>
          </form>
        </div>
      ) : null}

      <div className="dvx-card" style={{ marginTop: "1.5rem" }}>
        {sources.length === 0 ? (
          <p className="dvx-muted" style={{ fontSize: "0.85rem" }}>
            No knowledge sources yet.
          </p>
        ) : (
          <div className="dvx-team-member-list">
            {sources.map((source) => (
              <div key={source.id} className="dvx-team-member-row">
                <span className="dvx-team-member-name">
                  {source.title}
                  <span className="dvx-muted" style={{ marginLeft: "0.5rem", fontSize: "0.78rem" }}>
                    {source.source_type.replace(/_/g, " ")}
                  </span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span
                    className={`dvx-badge ${STATUS_BADGE[source.ingestion_status] ?? "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                    title={source.ingestion_error ?? undefined}
                  >
                    {source.ingestion_status.replace(/_/g, " ")}
                  </span>
                  <span
                    className={`dvx-badge ${source.is_enabled ? "dvx-badge--success" : "dvx-badge--neutral"}`}
                    style={{ fontSize: "0.7rem" }}
                  >
                    {source.is_enabled ? "Enabled" : "Disabled"}
                  </span>
                  {capabilities.canManageKnowledge ? (
                    <>
                      <form action={toggleKnowledgeSourceAction}>
                        <input type="hidden" name="source_id" value={source.id} />
                        <input
                          type="hidden"
                          name="next_enabled"
                          value={(!source.is_enabled).toString()}
                        />
                        <button
                          className="dvx-button dvx-button--secondary"
                          type="submit"
                          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                        >
                          {source.is_enabled ? "Disable" : "Enable"}
                        </button>
                      </form>
                      <form action={removeKnowledgeSourceAction}>
                        <input type="hidden" name="source_id" value={source.id} />
                        <button
                          className="dvx-button dvx-button--secondary"
                          type="submit"
                          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
                        >
                          Remove
                        </button>
                      </form>
                    </>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
