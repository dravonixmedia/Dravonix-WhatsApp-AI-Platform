import { describe, expect, it } from "vitest";
import {
  aiModeBadgeClass,
  aiModeBadgeLabel,
  conversationStateLabel,
  isHandoverState,
  leadStageBadgeClass,
  leadStageLabel,
  outboundStatusBadgeClass,
  outboundStatusLabel,
} from "../app/dashboard/badges.js";

/**
 * Pure-function coverage for the dashboard's single source of truth for
 * status badge labels/colors (app/dashboard/badges.tsx) -- every page that
 * renders an AI mode, conversation state, outbound delivery status, or lead
 * stage badge goes through these functions, so a regression here would be
 * visible across every redesigned page at once.
 */
describe("aiModeBadge", () => {
  it("labels active as AI Active with a success tone", () => {
    expect(aiModeBadgeLabel("active")).toBe("AI Active");
    expect(aiModeBadgeClass("active")).toContain("dvx-badge--success");
  });

  it("labels paused as AI Paused with a warning tone", () => {
    expect(aiModeBadgeLabel("paused")).toBe("AI Paused");
    expect(aiModeBadgeClass("paused")).toContain("dvx-badge--warning");
  });
});

describe("isHandoverState / conversationStateLabel", () => {
  it("treats handover_requested and queued_for_agent as handover states", () => {
    expect(isHandoverState("handover_requested")).toBe(true);
    expect(isHandoverState("queued_for_agent")).toBe(true);
  });

  it("does not treat ai_active, human_active, or closed as handover states", () => {
    expect(isHandoverState("ai_active")).toBe(false);
    expect(isHandoverState("human_active")).toBe(false);
    expect(isHandoverState("closed")).toBe(false);
  });

  it("produces a human-readable label for every conversation state", () => {
    expect(conversationStateLabel("ai_active")).toBe("AI handling");
    expect(conversationStateLabel("handover_requested")).toBe("Handover requested");
    expect(conversationStateLabel("queued_for_agent")).toBe("Queued");
    expect(conversationStateLabel("human_active")).toBe("Human active");
    expect(conversationStateLabel("closed")).toBe("Closed");
  });
});

describe("outboundStatusBadge", () => {
  it("maps sent to a success tone and send_failed to a danger tone", () => {
    expect(outboundStatusBadgeClass("sent")).toContain("dvx-badge--success");
    expect(outboundStatusBadgeClass("send_failed")).toContain("dvx-badge--danger");
  });

  it("maps delivery_unknown to a warning tone -- the state that requires manual reconciliation", () => {
    expect(outboundStatusBadgeClass("delivery_unknown")).toContain("dvx-badge--warning");
    expect(outboundStatusLabel("delivery_unknown")).toBe("Delivery unknown");
  });

  it("renders no label at all for a null status (an inbound message)", () => {
    expect(outboundStatusLabel(null)).toBe("");
  });
});

describe("leadStageBadge", () => {
  it("maps won to success and lost to danger", () => {
    expect(leadStageBadgeClass("won")).toContain("dvx-badge--success");
    expect(leadStageBadgeClass("lost")).toContain("dvx-badge--danger");
  });

  it("renders the stage label with underscores replaced by spaces", () => {
    expect(leadStageLabel("proposal_sent")).toBe("proposal sent");
  });
});
