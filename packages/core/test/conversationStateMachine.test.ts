import { describe, expect, it } from "vitest";
import {
  applyConversationEvent,
  InvalidStateTransitionError,
  isAiReplyAllowed,
} from "../src/index.js";

describe("conversation state machine", () => {
  it("moves from ai_active to handover_requested on handover_triggered", () => {
    expect(applyConversationEvent("ai_active", "handover_triggered")).toBe("handover_requested");
  });

  it("moves from handover_requested to human_active when an agent is assigned", () => {
    expect(applyConversationEvent("handover_requested", "agent_assigned")).toBe("human_active");
  });

  it("returns to ai_active when an agent hands the conversation back", () => {
    expect(applyConversationEvent("human_active", "agent_returns_to_ai")).toBe("ai_active");
  });

  it("rejects an invalid transition instead of coercing state", () => {
    expect(() => applyConversationEvent("closed", "agent_assigned")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("rejects assigning an agent directly from ai_active", () => {
    expect(() => applyConversationEvent("ai_active", "agent_assigned")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("suppresses AI replies once a human has taken control", () => {
    expect(isAiReplyAllowed("ai_active")).toBe(true);
    expect(isAiReplyAllowed("human_active")).toBe(false);
    expect(isAiReplyAllowed("handover_requested")).toBe(false);
    expect(isAiReplyAllowed("paused")).toBe(false);
    expect(isAiReplyAllowed("closed")).toBe(false);
  });

  it("allows reopening a closed conversation back into ai_active", () => {
    expect(applyConversationEvent("closed", "conversation_reopened")).toBe("ai_active");
  });

  it("has no direct handover_requested -> ai_active transition (must go through human_active first)", () => {
    // Documents a real gap found while diagnosing a staging incident: a
    // conversation that lands in handover_requested (e.g. via the AI's safe
    // fallback after repeated validation failure) can only return to
    // ai_active by first being assigned to an agent (agent_assigned ->
    // human_active) and then handed back (agent_returns_to_ai). There is no
    // shortcut straight from handover_requested to ai_active today.
    expect(() => applyConversationEvent("handover_requested", "agent_returns_to_ai")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("returns to ai_active from human_active after being routed through handover_requested", () => {
    const afterHandover = applyConversationEvent("ai_active", "handover_triggered");
    const afterAssignment = applyConversationEvent(afterHandover, "agent_assigned");
    expect(applyConversationEvent(afterAssignment, "agent_returns_to_ai")).toBe("ai_active");
  });
});
