import { describe, expect, it } from "vitest";
import {
  applyConversationEvent,
  InvalidStateTransitionError,
  isAiReplyAllowed,
  statesAllowingEvent,
  type AiMode,
  type ConversationState,
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

  it("allows reopening a closed conversation back into ai_active", () => {
    expect(applyConversationEvent("closed", "conversation_reopened")).toBe("ai_active");
  });

  it("moves handover_requested to queued_for_agent on agent_queues (Mark as queued)", () => {
    expect(applyConversationEvent("handover_requested", "agent_queues")).toBe("queued_for_agent");
  });

  it("allows End human assistance (agent_returns_to_ai) directly from handover_requested", () => {
    // Human Handover Inbox final plan §10: declining a handover must not
    // require faking an assignment first. This replaces the old, narrower
    // gap-documenting test (a conversation could only return to ai_active by
    // first being assigned to an agent) now that the direct transition exists.
    expect(applyConversationEvent("handover_requested", "agent_returns_to_ai")).toBe("ai_active");
  });

  it("allows End human assistance directly from queued_for_agent", () => {
    expect(applyConversationEvent("queued_for_agent", "agent_returns_to_ai")).toBe("ai_active");
  });

  it("still returns to ai_active from human_active after being routed through handover_requested", () => {
    const afterHandover = applyConversationEvent("ai_active", "handover_triggered");
    const afterAssignment = applyConversationEvent(afterHandover, "agent_assigned");
    expect(applyConversationEvent(afterAssignment, "agent_returns_to_ai")).toBe("ai_active");
  });

  describe("statesAllowingEvent", () => {
    it("derives exactly the states that accept agent_assigned", () => {
      expect(statesAllowingEvent("agent_assigned").sort()).toEqual(
        ["handover_requested", "queued_for_agent"].sort(),
      );
    });

    it("derives exactly the states that accept agent_returns_to_ai", () => {
      expect(statesAllowingEvent("agent_returns_to_ai").sort()).toEqual(
        ["handover_requested", "queued_for_agent", "human_active", "paused"].sort(),
      );
    });
  });

  describe("isAiReplyAllowed -- collaborative handover model (final plan §5)", () => {
    const allStates: ConversationState[] = [
      "ai_active",
      "handover_requested",
      "queued_for_agent",
      "human_active",
      "paused",
      "closed",
    ];
    const modes: AiMode[] = ["active", "paused"];

    it("allows AI replies in ai_active, handover_requested, queued_for_agent, and human_active when ai_mode is active", () => {
      for (const state of [
        "ai_active",
        "handover_requested",
        "queued_for_agent",
        "human_active",
      ] as const) {
        expect(isAiReplyAllowed(state, "active")).toBe(true);
      }
    });

    it("assigning/starting a human conversation does not by itself disable AI (human_active + active = allowed)", () => {
      expect(isAiReplyAllowed("human_active", "active")).toBe(true);
    });

    it("suppresses AI whenever ai_mode is paused, regardless of conversation state", () => {
      for (const state of allStates) {
        expect(isAiReplyAllowed(state, "paused")).toBe(false);
      }
    });

    it("suppresses AI in the paused conversation state regardless of ai_mode", () => {
      for (const mode of modes) {
        expect(isAiReplyAllowed("paused", mode)).toBe(false);
      }
    });

    it("suppresses AI in the closed conversation state regardless of ai_mode", () => {
      for (const mode of modes) {
        expect(isAiReplyAllowed("closed", mode)).toBe(false);
      }
    });
  });
});
