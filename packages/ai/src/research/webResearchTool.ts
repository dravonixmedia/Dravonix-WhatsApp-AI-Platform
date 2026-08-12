import { z } from "zod";

/**
 * Minimal local shape matching the Anthropic Messages API's tool-definition
 * format (`tools[]` on a `messages.create` call). Defined locally instead of
 * imported from `@anthropic-ai/sdk` so this module has zero dependency on
 * SDK internals and compiles standalone -- Phase 1 does not wire this tool
 * into any live `messages.create` call (see boundedExecution.ts / the
 * orchestrator seam in orchestrate.ts for what IS wired).
 */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const WEB_RESEARCH_TOOL_NAME = "web_research" as const;

/**
 * The future `web_research` tool definition. Not attached to any live
 * Claude call in Phase 1 -- this is the agreed shape for when tool-calling
 * is wired into AnthropicProvider (Phase 2+). The description is the
 * primary enforcement surface for query privacy today (the model reads it
 * directly); querySanitizer.ts is the structural backstop for whatever the
 * model sends regardless of whether it follows this instruction.
 */
export const WEB_RESEARCH_TOOL_DEFINITION: AnthropicToolDefinition = {
  name: WEB_RESEARCH_TOOL_NAME,
  description:
    "Search the public web for CURRENT, PUBLIC information when the company's own knowledge cannot answer " +
    "the customer's question and the question needs up-to-date or general public/industry information " +
    "(for example: market trends, competitor information, public regulations, current material or product " +
    "information, general market pricing ranges). Use this tool AT MOST ONCE per customer turn -- never call " +
    "it more than once, and never use it when the company's own knowledge already answers the question. " +
    "The `query` you provide MUST be a public, business-safe research query about the general TOPIC only. " +
    "It must NEVER include: phone numbers; internal database IDs (conversation, contact, or company IDs); " +
    "private conversation history; credentials or API keys; or references to private customer documents. " +
    'Formulate a general public search query (for example "luxury villa interior design trends Dubai 2026"), ' +
    "never the customer's literal message, name, or identity.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 3,
        description:
          "A public, business-safe web search query describing the general topic to research. Must not " +
          "contain any customer-identifying or internal information.",
      },
    },
    required: ["query"],
  },
};

/** Runtime validator for a `web_research` tool_use input, mirroring the zod-schema discipline used for the customer-facing structured response (see schema.ts). */
export const webResearchToolInputSchema = z.object({
  query: z.string().min(3),
});

export type WebResearchToolInput = z.infer<typeof webResearchToolInputSchema>;
