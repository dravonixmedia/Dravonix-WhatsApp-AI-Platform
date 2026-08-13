import type { ConversationTemporalContext } from "@dravonix/core";
import type { LiveResearchExecutionMetadata } from "./research/types.js";

export interface CompanyAiContext {
  companyId: string;
  companyName: string;
  botName: string;
  tone: string;
  enabledLanguages: string[];
  fallbackLanguage: string;
  approvedServices: string[];
  approvedProducts: string[];
  pricingRules: string[];
  businessHours: string | null;
  policies: string[];
  faqs: Array<{ question: string; answer: string }>;
  restrictedTopics: string[];
  requiredDisclaimers: string[];
  handoverRules: string[];
  confidenceThreshold: number;
  staticFallbackMessage: string;
  /** Whether this company has speech-to-text/text-to-speech enabled (voice_settings.is_enabled). */
  voiceEnabled: boolean;
  /**
   * companies.is_demo -- part of the DRAIVA Research staging-pilot gate
   * (packages/config's RESEARCH_STAGING_ENABLED AND this flag must both be
   * true; see processMessageJob.ts). Optional and defaults to falsy so every
   * existing CompanyAiContext object literal (test fixtures, the internal
   * Chat Agent, which never reads this field at all) stays valid unchanged.
   */
  isDemo?: boolean;
}

export interface ConversationMemoryContext {
  recentMessages: Array<{ role: "customer" | "ai" | "human_agent"; body: string }>;
  summary: string | null;
  leadState: Record<string, unknown>;
  unresolvedQuestions: string[];
  customerReplyPreference: string | null;
  lastDetectedLanguage: string | null;
}

export interface RetrievedKnowledgeSnippet {
  sourceId: string;
  title: string;
  content: string;
  relevance: number;
}

export interface AiGenerationInput {
  company: CompanyAiContext;
  memory: ConversationMemoryContext;
  knowledge: RetrievedKnowledgeSnippet[];
  customerMessage: string;
  /**
   * Server-side-resolved company/customer local date, time, and daypart for
   * this exact request (Global Timezone + Daypart Awareness). Computed once
   * per request from the caller's real stored timezones -- never inferred
   * from phone number, never a module-scope `new Date()`.
   */
  temporal: ConversationTemporalContext;
  /**
   * The language actually detected for THIS turn's inbound message (e.g. a
   * voice note's STT-detected language), when known -- takes priority over
   * memory.lastDetectedLanguage (which reflects a PRIOR turn) for choosing
   * the language of any safe-fallback text and for the repair instruction.
   * Omitted for text messages, which have no separate detection step.
   */
  currentDetectedLanguage?: string | null;
  /**
   * DRAIVA Research: when true, AnthropicProvider attaches Anthropic's
   * native web_search tool to this call (never on a repair attempt -- see
   * providers/anthropicProvider.ts) and buildSystemPrompt adds the
   * company-knowledge-first / company-fact-vs-research-separation
   * instructions. Omitted/false (the default for every current caller)
   * preserves today's exact single-shot, tool-free behavior byte for byte.
   */
  researchEnabled?: boolean;
  /**
   * DRAIVA Research: set by orchestrate.ts (research/intentDetector.ts) when
   * the customer's current message was deterministically classified as an
   * explicit RESEARCH ACTION REQUEST. Only meaningful when researchEnabled
   * is also true (see anthropicProvider.ts) -- when both are true, the
   * provider forces web_search tool use for this turn (tool_choice) instead
   * of leaving it to the model's own judgment. Omitted/false preserves the
   * existing model-judgment-only behavior.
   */
  researchRequired?: boolean;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AiGenerationResult {
  rawText: string;
  usage: AiUsage;
  /** Present only when input.researchEnabled was true for this call. Sanitized, structural metadata about Anthropic's native web-search tool use during this turn -- never raw provider payloads. */
  research?: LiveResearchExecutionMetadata;
}

/**
 * Provider-agnostic AI interface (ADR-0004). `repairInstruction`, when present,
 * asks the provider to correct its previous invalid output within the same
 * logical turn -- it must not be treated as a new customer message.
 */
export interface AiProvider {
  generate(input: AiGenerationInput, repairInstruction?: string): Promise<AiGenerationResult>;
}
