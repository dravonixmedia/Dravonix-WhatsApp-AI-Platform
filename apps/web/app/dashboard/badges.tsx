import type {
  ConversationAiMode,
  ConversationState,
  OutboundDeliveryStatus,
} from "@dravonix/handover";
import type { LeadStage } from "../../lib/repositories/leadsRepository.js";

/**
 * Single source of truth for every status badge's label + color across the
 * dashboard (AI Active/Paused, Handover, Sent/Failed/delivery-unknown, lead
 * stages) -- pure functions so they're unit-testable without rendering, and
 * so every page renders the exact same label/color for the exact same
 * underlying value instead of re-deriving it ad hoc per page.
 */

export function aiModeBadgeClass(aiMode: ConversationAiMode): string {
  return aiMode === "active" ? "dvx-badge dvx-badge--success" : "dvx-badge dvx-badge--warning";
}

export function aiModeBadgeLabel(aiMode: ConversationAiMode): string {
  return aiMode === "active" ? "AI Active" : "AI Paused";
}

export function AiModeBadge({ aiMode }: { aiMode: ConversationAiMode }) {
  return <span className={aiModeBadgeClass(aiMode)}>{aiModeBadgeLabel(aiMode)}</span>;
}

const HANDOVER_STATES = new Set<ConversationState>(["handover_requested", "queued_for_agent"]);

export function isHandoverState(state: ConversationState): boolean {
  return HANDOVER_STATES.has(state);
}

export function conversationStateLabel(state: ConversationState): string {
  switch (state) {
    case "ai_active":
      return "AI handling";
    case "handover_requested":
      return "Handover requested";
    case "queued_for_agent":
      return "Queued";
    case "human_active":
      return "Human active";
    case "closed":
      return "Closed";
    default:
      return state;
  }
}

export function ConversationStateBadge({ state }: { state: ConversationState }) {
  if (state === "closed") {
    return <span className="dvx-badge dvx-badge--neutral">{conversationStateLabel(state)}</span>;
  }
  if (isHandoverState(state) || state === "human_active") {
    return <span className="dvx-badge dvx-badge--info">{conversationStateLabel(state)}</span>;
  }
  return <span className="dvx-badge dvx-badge--brand">{conversationStateLabel(state)}</span>;
}

export function outboundStatusBadgeClass(status: OutboundDeliveryStatus | null): string {
  switch (status) {
    case "sent":
      return "dvx-badge dvx-badge--success";
    case "send_failed":
      return "dvx-badge dvx-badge--danger";
    case "delivery_unknown":
      return "dvx-badge dvx-badge--warning";
    case "sending":
    case "reserved":
      return "dvx-badge dvx-badge--info";
    default:
      return "dvx-badge dvx-badge--neutral";
  }
}

export function outboundStatusLabel(status: OutboundDeliveryStatus | null): string {
  switch (status) {
    case "sent":
      return "Sent";
    case "send_failed":
      return "Failed";
    case "delivery_unknown":
      return "Delivery unknown";
    case "sending":
      return "Sending";
    case "reserved":
      return "Reserved";
    default:
      return "";
  }
}

export function OutboundStatusBadge({ status }: { status: OutboundDeliveryStatus | null }) {
  if (!status) return null;
  return <span className={outboundStatusBadgeClass(status)}>{outboundStatusLabel(status)}</span>;
}

export function leadStageBadgeClass(stage: LeadStage): string {
  switch (stage) {
    case "won":
      return "dvx-badge dvx-badge--success";
    case "lost":
      return "dvx-badge dvx-badge--danger";
    case "qualified":
    case "proposal_sent":
      return "dvx-badge dvx-badge--brand";
    default:
      return "dvx-badge dvx-badge--neutral";
  }
}

export function leadStageLabel(stage: LeadStage): string {
  return stage.replace(/_/g, " ");
}

export function LeadStageBadge({ stage }: { stage: LeadStage }) {
  return <span className={leadStageBadgeClass(stage)}>{leadStageLabel(stage)}</span>;
}
