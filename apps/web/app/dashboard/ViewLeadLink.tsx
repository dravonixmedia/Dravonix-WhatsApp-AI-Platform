import Link from "next/link";

/**
 * Reciprocal to the Lead detail page's own "View conversation" link
 * (apps/web/app/dashboard/leads/[leadId]/page.tsx) -- shared by both
 * conversation-detail-style routes (Live Conversations, Human Handover) so
 * they never diverge. Renders nothing when no lead is associated with this
 * conversation, never a disabled/misleading action.
 */
export function ViewLeadLink({ leadId }: { leadId: string | null }) {
  if (!leadId) return null;
  return (
    <Link
      href={`/dashboard/leads/${leadId}`}
      className="dvx-button dvx-button--secondary"
      style={{ fontSize: "0.8rem", textDecoration: "none" }}
    >
      View lead
    </Link>
  );
}
