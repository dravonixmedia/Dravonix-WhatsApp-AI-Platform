export default function InboxPage() {
  return (
    <div>
      <h1 style={{ fontSize: "1.4rem" }}>Inbox</h1>
      <p className="dvx-muted">
        Conversations will appear here once the company's WhatsApp number is connected and a
        customer sends a message. Wired to <code>GET /companies/:id/conversations</code> (apps/api,
        to be added) — the conversation state machine, handover, and note-taking logic already exist
        in <code>packages/core</code> and are exercised end to end by
        <code> apps/workers/message-consumer</code>.
      </p>
      <div className="dvx-card" style={{ marginTop: "1rem" }}>
        <p className="dvx-muted" style={{ margin: 0 }}>
          No conversations yet.
        </p>
      </div>
    </div>
  );
}
