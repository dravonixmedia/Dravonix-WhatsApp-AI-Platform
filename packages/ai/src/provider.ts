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
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AiGenerationResult {
  rawText: string;
  usage: AiUsage;
}

/**
 * Provider-agnostic AI interface (ADR-0004). `repairInstruction`, when present,
 * asks the provider to correct its previous invalid output within the same
 * logical turn -- it must not be treated as a new customer message.
 */
export interface AiProvider {
  generate(input: AiGenerationInput, repairInstruction?: string): Promise<AiGenerationResult>;
}
