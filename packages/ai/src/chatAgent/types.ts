import type { ConversationTemporalContext } from "@dravonix/core";

/**
 * Dashboard Chat Agent (internal staff copilot -- NOT the customer-facing
 * WhatsApp AI, which remains entirely unchanged). Every type here describes
 * server-loaded, already-authorized context; nothing in this module ever
 * reads a company id, permission, or full conversation dump from the
 * browser -- that boundary is enforced in apps/web/lib/actions/chatAgent.ts,
 * which is the only caller of this package's chat-agent functions.
 */

export type ChatAgentActionType =
  | "summarize"
  | "suggest_reply"
  | "rewrite_draft"
  | "translate"
  | "extract_lead"
  | "prepare_follow_up"
  | "ask_question";

export const CHAT_AGENT_ACTION_TYPES: readonly ChatAgentActionType[] = [
  "summarize",
  "suggest_reply",
  "rewrite_draft",
  "translate",
  "extract_lead",
  "prepare_follow_up",
  "ask_question",
];

export type ChatAgentRewriteTone =
  "professional" | "friendly" | "concise" | "persuasive" | "polite";

export const CHAT_AGENT_REWRITE_TONES: readonly ChatAgentRewriteTone[] = [
  "professional",
  "friendly",
  "concise",
  "persuasive",
  "polite",
];

/** BCP-47-ish codes for the languages this MVP officially supports translating into. */
export type ChatAgentSupportedLanguage = "en" | "ml" | "hi" | "ar";

export const CHAT_AGENT_SUPPORTED_LANGUAGES: Record<ChatAgentSupportedLanguage, string> = {
  en: "English",
  ml: "Malayalam",
  hi: "Hindi",
  ar: "Arabic",
};

export interface ChatAgentMessage {
  direction: "inbound" | "outbound";
  senderType: "customer" | "ai" | "human_agent" | "system";
  body: string;
  createdAt: string;
}

/** Only the approved, already-used-by-the-system AI configuration fields -- never bot_name/business_hours/confidence_threshold/internal reply-mode plumbing. */
export interface ChatAgentCompanyContext {
  companyName: string;
  tone: string;
  enabledLanguages: string[];
  fallbackLanguage: string;
  restrictedTopics: string[];
}

export interface ChatAgentConversationState {
  state: string;
  aiMode: "active" | "paused";
}

export interface ChatAgentContactContext {
  displayName: string | null;
  maskedPhoneNumber: string;
  lastDetectedLanguage: string | null;
}

/** Existing, already-persisted lead fields -- read-only, never written back by the Chat Agent. */
export interface ChatAgentLeadContext {
  customerName: string | null;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  serviceInterest: string | null;
  budget: string | null;
  timeline: string | null;
  location: string | null;
  notes: string | null;
}

export interface ChatAgentInput {
  action: ChatAgentActionType;
  /** Already windowed to a bounded count/size by selectBoundedHistory -- see historySelection.ts. */
  messages: ChatAgentMessage[];
  /** True when selectBoundedHistory dropped older messages -- the system prompt must then say so explicitly. */
  historyTruncated: boolean;
  company: ChatAgentCompanyContext;
  conversation: ChatAgentConversationState;
  contact: ChatAgentContactContext | null;
  lead: ChatAgentLeadContext | null;
  /** Same resolver/shape as the automatic WhatsApp reply pipeline's -- see @dravonix/core's resolveConversationTemporalContext. */
  temporal: ConversationTemporalContext;
  /** Required for rewrite_draft; optional context for suggest_reply. */
  staffDraft?: string;
  /** Required for translate. */
  targetLanguage?: ChatAgentSupportedLanguage;
  /** Required for rewrite_draft. */
  tone?: ChatAgentRewriteTone;
  /** Required for ask_question. */
  question?: string;
}

export interface ChatAgentSummary {
  customerRequest: string;
  importantDetails: string[];
  currentStatus: string;
  unansweredQuestions: string[];
  recommendedNextStep: string;
}

export interface ChatAgentLeadExtraction {
  customerName: string;
  phone: string;
  email: string;
  company: string;
  requestedService: string;
  budget: string;
  timeline: string;
  location: string;
  meetingRequested: string;
  callbackRequested: string;
  quotationRequested: string;
  purchaseIntent: string;
  importantNotes: string;
}

/**
 * Uniform result shape for every action -- `displayText` is always a
 * ready-to-render, plain-text (never markdown-fenced JSON) result so the
 * dashboard panel needs only one rendering path. `structured` carries the
 * validated object for summarize/extract_lead, for callers that want it
 * (e.g. future structured rendering); the MVP UI only renders displayText.
 */
export interface ChatAgentResult {
  action: ChatAgentActionType;
  displayText: string;
  structured?: ChatAgentSummary | ChatAgentLeadExtraction;
  historyTruncated: boolean;
}
