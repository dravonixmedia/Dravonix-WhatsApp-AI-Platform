export default function KnowledgePage() {
  return (
    <div>
      <h1 style={{ fontSize: "1.4rem" }}>Knowledge Base</h1>
      <p className="dvx-muted">
        Services, pricing, FAQs, policies, and uploaded documents that ground the chatbot's answers
        (see <code>packages/knowledge</code> for the retrieval and ingestion pipeline). The demo
        tenant is pre-seeded with sample services, demo pricing, and an FAQ entry — see
        <code> supabase/seed/002_demo_tenant.sql</code>.
      </p>
      <div className="dvx-card" style={{ marginTop: "1rem" }}>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Connect a database to list knowledge sources here.
        </p>
      </div>
    </div>
  );
}
