import Link from "next/link";
import { notFound } from "next/navigation";
import {
  assignLeadAction,
  updateLeadNotesAction,
  updateLeadStageAction,
} from "../../../../lib/actions/leads.js";
import { getDashboardCapabilities } from "../../../../lib/permissions.js";
import { RealtimeRefreshBoundary } from "../../../../lib/realtime/RealtimeRefreshBoundary.js";
import { LEAD_DETAIL_WATCHES } from "../../../../lib/realtime/watchConfigs.js";
import {
  getLead,
  listLeadEvents,
  type LeadStage,
} from "../../../../lib/repositories/leadsRepository.js";
import { getDashboardSession } from "../../../../lib/session.js";
import { createServerSupabaseClient } from "../../../../lib/supabase/server.js";
import { Avatar } from "../../Avatar.js";
import { LeadStageBadge } from "../../badges.js";

const STAGE_OPTIONS: Array<{ value: LeadStage; label: string }> = [
  { value: "new", label: "New" },
  { value: "qualifying", label: "Qualifying" },
  { value: "qualified", label: "Qualified" },
  { value: "proposal_sent", label: "Proposal sent" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

const NOT_PROVIDED = "Not provided";

/**
 * Always renders the row -- every field here is a real, always-present
 * column in the leads schema, so the row itself is never hidden. Only the
 * per-lead *value* is conditional: a null column value renders the neutral
 * "Not provided" label rather than being fabricated or silently omitted.
 */
function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <div className="dvx-muted" style={{ fontSize: "0.75rem" }}>
        {label}
      </div>
      <div className={value ? undefined : "dvx-muted"}>{value ?? NOT_PROVIDED}</div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function LeadDetailPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  const session = await getDashboardSession();
  if (!session) return null;

  const capabilities = getDashboardCapabilities(session.activeRole);
  if (!capabilities.canViewLeads) {
    return (
      <div className="dvx-card" style={{ maxWidth: 480 }}>
        <p className="dvx-muted" style={{ margin: 0 }}>
          Your role does not have permission to view leads.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();
  const lead = await getLead(supabase, session.activeCompanyId, leadId);
  if (!lead) notFound();

  const events = await listLeadEvents(supabase, session.activeCompanyId, leadId);
  const latestEvent = events[0] ?? null;

  const { data: members } = capabilities.canManageLeads
    ? await supabase
        .from("company_members")
        .select("id, role")
        .eq("company_id", session.activeCompanyId)
        .eq("is_active", true)
    : { data: null };

  return (
    <div>
      <RealtimeRefreshBoundary
        namespace="lead-detail"
        scopeId={leadId}
        accessToken={session.accessToken}
        watches={LEAD_DETAIL_WATCHES}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <Avatar label={lead.displayName} size={44} />
          <div>
            <h1 style={{ fontSize: "1.3rem", margin: 0 }}>{lead.displayName}</h1>
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.3rem" }}
            >
              <LeadStageBadge stage={lead.stage} />
              <span className="dvx-muted" style={{ fontSize: "0.8rem" }}>
                source: {lead.source}
                {lead.score !== null ? ` · score: ${lead.score}` : ""}
              </span>
            </div>
          </div>
        </div>
        {lead.conversationId ? (
          <Link
            href={`/dashboard/conversations/${lead.conversationId}`}
            className="dvx-button dvx-button--secondary"
            style={{ fontSize: "0.8rem", textDecoration: "none" }}
          >
            View conversation
          </Link>
        ) : null}
      </div>

      {latestEvent ? (
        <p className="dvx-muted" style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
          Latest activity: {latestEvent.eventType.replace(/_/g, " ")} ·{" "}
          {relativeTime(latestEvent.createdAt)}
        </p>
      ) : null}

      <div className="dvx-card-grid dvx-card-grid--narrow" style={{ marginTop: "1.5rem" }}>
        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.6rem" }}>
            Contact
          </div>
          <DetailRow label="Customer name" value={lead.customerName} />
          <DetailRow label="Company" value={lead.companyName} />
          <DetailRow label="WhatsApp number" value={lead.maskedPhoneNumber} />
          <DetailRow label="Email" value={lead.email} />
          <DetailRow label="Location" value={lead.location} />
          <DetailRow label="Branch" value={lead.branch} />
        </div>
        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.6rem" }}>
            Interest
          </div>
          <DetailRow label="Service interest" value={lead.serviceInterest} />
          <DetailRow label="Product interest" value={lead.productInterest} />
          <DetailRow label="Budget" value={lead.budget} />
          <DetailRow label="Preferred timeline" value={lead.preferredTimeline} />
        </div>
        <div className="dvx-card">
          <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.6rem" }}>
            Ownership
          </div>
          <DetailRow
            label="Assigned to"
            value={lead.assignedMemberId ? lead.assignedMemberId.slice(0, 8) : null}
          />
          <DetailRow label="Created" value={new Date(lead.createdAt).toLocaleString()} />
          <DetailRow label="Last updated" value={new Date(lead.updatedAt).toLocaleString()} />
        </div>
      </div>

      {capabilities.canManageLeads ? (
        <div
          className="dvx-card"
          style={{ marginTop: "1rem", display: "flex", gap: "1.5rem", flexWrap: "wrap" }}
        >
          <form
            action={async (formData) => {
              "use server";
              await updateLeadStageAction(leadId, String(formData.get("stage")));
            }}
            style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}
          >
            <label className="dvx-muted" style={{ fontSize: "0.8rem" }}>
              Stage
            </label>
            <select name="stage" defaultValue={lead.stage} className="dvx-input">
              {STAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button className="dvx-button" type="submit" style={{ fontSize: "0.8rem" }}>
              Update
            </button>
          </form>

          {members && members.length > 0 ? (
            <form
              action={async (formData) => {
                "use server";
                const value = String(formData.get("targetMemberId"));
                await assignLeadAction(leadId, value === "" ? null : value);
              }}
              style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}
            >
              <label className="dvx-muted" style={{ fontSize: "0.8rem" }}>
                Assigned to
              </label>
              <select
                name="targetMemberId"
                defaultValue={lead.assignedMemberId ?? ""}
                className="dvx-input"
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id as string} value={m.id as string}>
                    {m.role as string} ({(m.id as string).slice(0, 8)})
                  </option>
                ))}
              </select>
              <button className="dvx-button" type="submit" style={{ fontSize: "0.8rem" }}>
                Assign
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {capabilities.canManageLeads ? (
        <form
          action={async (formData) => {
            "use server";
            await updateLeadNotesAction(leadId, String(formData.get("notes")));
          }}
          className="dvx-card"
          style={{ marginTop: "1rem" }}
        >
          <label className="dvx-muted" style={{ fontSize: "0.8rem" }}>
            Notes
          </label>
          <textarea
            name="notes"
            defaultValue={lead.notes ?? ""}
            className="dvx-input"
            rows={4}
            style={{ marginTop: "0.4rem", resize: "vertical" }}
          />
          <button
            className="dvx-button"
            type="submit"
            style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}
          >
            Save notes
          </button>
        </form>
      ) : lead.notes ? (
        <div className="dvx-card" style={{ marginTop: "1rem" }}>
          <div className="dvx-muted" style={{ fontSize: "0.75rem" }}>
            Notes
          </div>
          <div>{lead.notes}</div>
        </div>
      ) : null}

      {events.length > 0 ? (
        <div style={{ marginTop: "1.5rem" }}>
          <h2 className="dvx-muted" style={{ fontSize: "0.85rem", textTransform: "uppercase" }}>
            Activity
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {events.map((event) => (
              <div key={event.id} className="dvx-card" style={{ fontSize: "0.85rem" }}>
                <span className="dvx-muted" style={{ fontSize: "0.75rem" }}>
                  {new Date(event.createdAt).toLocaleString()} ·{" "}
                </span>
                {event.eventType.replace(/_/g, " ")}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
