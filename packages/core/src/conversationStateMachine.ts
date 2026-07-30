import { InvalidStateTransitionError } from "./errors.js";

/** Master Prompt section 16. */
export type ConversationState =
  "ai_active" | "handover_requested" | "queued_for_agent" | "human_active" | "paused" | "closed";

export type ConversationEvent =
  | "customer_message_received"
  | "handover_triggered"
  | "agent_assigned"
  | "agent_returns_to_ai"
  | "agent_pauses"
  | "agent_resumes"
  | "conversation_closed"
  | "conversation_reopened";

type Transitions = Record<ConversationState, Partial<Record<ConversationEvent, ConversationState>>>;

/**
 * Deterministic conversation/handover state machine. Any (state, event) pair not
 * listed here is rejected by `applyConversationEvent` rather than silently coerced.
 */
export const conversationTransitions: Transitions = {
  ai_active: {
    customer_message_received: "ai_active",
    handover_triggered: "handover_requested",
    conversation_closed: "closed",
  },
  handover_requested: {
    agent_assigned: "human_active",
    conversation_closed: "closed",
  },
  queued_for_agent: {
    agent_assigned: "human_active",
    conversation_closed: "closed",
  },
  human_active: {
    agent_returns_to_ai: "ai_active",
    agent_pauses: "paused",
    conversation_closed: "closed",
    customer_message_received: "human_active",
  },
  paused: {
    agent_resumes: "human_active",
    agent_returns_to_ai: "ai_active",
    conversation_closed: "closed",
  },
  closed: {
    conversation_reopened: "ai_active",
  },
};

export function applyConversationEvent(
  currentState: ConversationState,
  event: ConversationEvent,
): ConversationState {
  const nextState = conversationTransitions[currentState][event];
  if (!nextState) {
    throw new InvalidStateTransitionError(currentState, event);
  }
  return nextState;
}

/** While in these states, AI must never send an automatic reply (Master Prompt §16). */
export const AI_REPLY_SUPPRESSED_STATES: ReadonlySet<ConversationState> = new Set([
  "handover_requested",
  "queued_for_agent",
  "human_active",
  "paused",
  "closed",
]);

export function isAiReplyAllowed(state: ConversationState): boolean {
  return !AI_REPLY_SUPPRESSED_STATES.has(state);
}
