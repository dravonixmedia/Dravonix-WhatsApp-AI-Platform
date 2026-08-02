import { InvalidStateTransitionError } from "./errors.js";

/** Master Prompt section 16. */
export type ConversationState =
  "ai_active" | "handover_requested" | "queued_for_agent" | "human_active" | "paused" | "closed";

/**
 * AI automation mode -- deliberately separate from ConversationState (Human
 * Handover Inbox final plan §5). A human being assigned to, or actively
 * working, a conversation does not by itself stop the AI from replying:
 * handover is collaborative assistance, not an automatic AI replacement.
 * Only an explicit Pause AI/Resume AI action changes this.
 */
export type AiMode = "active" | "paused";

export type ConversationEvent =
  | "customer_message_received"
  | "handover_triggered"
  | "agent_assigned"
  | "agent_queues"
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
    agent_queues: "queued_for_agent",
    // "End human assistance" must work even if a human never actually
    // assigned themselves -- declining a handover shouldn't require faking
    // an assignment first (Human Handover Inbox final plan §10).
    agent_returns_to_ai: "ai_active",
    conversation_closed: "closed",
  },
  queued_for_agent: {
    agent_assigned: "human_active",
    agent_returns_to_ai: "ai_active",
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

/** Every state that can respond to `event`, derived from the transition table itself. */
export function statesAllowingEvent(event: ConversationEvent): ConversationState[] {
  return (Object.keys(conversationTransitions) as ConversationState[]).filter(
    (state) => conversationTransitions[state][event] !== undefined,
  );
}

/**
 * The conversation-level suppression states -- unrelated to ai_mode. `paused`
 * here is the pre-existing agent_pauses/agent_resumes conversation state
 * (e.g. an agent explicitly pausing the whole conversation), not the AI
 * automation mode. `closed` never gets automated replies either. Both this
 * AND `aiMode === "paused"` independently suppress AI -- see isAiReplyAllowed.
 */
export const AI_REPLY_SUPPRESSED_STATES: ReadonlySet<ConversationState> = new Set([
  "paused",
  "closed",
]);

/**
 * Collaborative handover model (Human Handover Inbox final plan §5): AI keeps
 * replying by default in ai_active, handover_requested, queued_for_agent, AND
 * human_active -- a human being assigned or actively assisting does not stop
 * the AI. AI is suppressed only when the conversation itself is paused or
 * closed, or when an authorized employee has explicitly paused the AI
 * (aiMode === "paused"). These two suppression mechanisms are independent and
 * neither implies the other.
 */
export function isAiReplyAllowed(state: ConversationState, aiMode: AiMode): boolean {
  if (AI_REPLY_SUPPRESSED_STATES.has(state)) return false;
  return aiMode === "active";
}
