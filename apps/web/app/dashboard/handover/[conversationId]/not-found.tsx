/**
 * Shown for a conversation that is missing, belongs to another company, is
 * hidden by RLS, or is no longer reachable after a membership revocation --
 * getConversationThreadForDashboard throws the same error for every one of
 * those cases (see lib/session.ts / page.tsx), so this page never reveals
 * which one actually happened.
 */
export default function ConversationNotFound() {
  return (
    <div className="dvx-card" style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Conversation unavailable</h1>
      <p className="dvx-muted" style={{ margin: 0 }}>
        This conversation doesn&apos;t exist, isn&apos;t part of your current company, or you no
        longer have access to it.
      </p>
    </div>
  );
}
