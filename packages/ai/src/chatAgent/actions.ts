import { z } from "zod";
import { ChatAgentResponseError, ChatAgentValidationError } from "./errors.js";
import {
  CHAT_AGENT_SUPPORTED_LANGUAGES,
  type ChatAgentInput,
  type ChatAgentLeadExtraction,
  type ChatAgentSummary,
} from "./types.js";

/** True when this action's model response must be JSON (summarize/extract_lead); false when it's plain text. */
export function isStructuredAction(action: ChatAgentInput["action"]): boolean {
  return action === "summarize" || action === "extract_lead";
}

/**
 * Validates the action-specific fields the browser is allowed to supply
 * (staffDraft/targetLanguage/tone/question) are present when the requested
 * action needs them -- thrown as ChatAgentValidationError, a safe, specific
 * message the dashboard can show directly (e.g. "A draft is required to
 * rewrite it."), never a generic 500.
 */
export function validateChatAgentInput(input: ChatAgentInput): void {
  if (input.action === "rewrite_draft") {
    if (!input.staffDraft?.trim()) {
      throw new ChatAgentValidationError(
        "Write a draft first, then ask the assistant to rewrite it.",
      );
    }
    if (!input.tone) {
      throw new ChatAgentValidationError("Choose a tone to rewrite the draft into.");
    }
  }
  if (input.action === "translate") {
    if (!input.staffDraft?.trim()) {
      throw new ChatAgentValidationError(
        "Write or generate a reply first, then ask the assistant to translate it.",
      );
    }
    if (!input.targetLanguage || !(input.targetLanguage in CHAT_AGENT_SUPPORTED_LANGUAGES)) {
      throw new ChatAgentValidationError("Choose a supported language to translate into.");
    }
  }
  if (input.action === "ask_question" && !input.question?.trim()) {
    throw new ChatAgentValidationError("Type a question to ask about this conversation.");
  }
}

const summarySchema = z.object({
  customerRequest: z.string(),
  importantDetails: z.array(z.string()),
  currentStatus: z.string(),
  unansweredQuestions: z.array(z.string()),
  recommendedNextStep: z.string(),
});

const leadExtractionSchema = z.object({
  customerName: z.string(),
  phone: z.string(),
  email: z.string(),
  company: z.string(),
  requestedService: z.string(),
  budget: z.string(),
  timeline: z.string(),
  location: z.string(),
  meetingRequested: z.string(),
  callbackRequested: z.string(),
  quotationRequested: z.string(),
  purchaseIntent: z.string(),
  importantNotes: z.string(),
});

const SUMMARY_JSON_SHAPE =
  '{"customerRequest": string, "importantDetails": string[], "currentStatus": string, ' +
  '"unansweredQuestions": string[], "recommendedNextStep": string}';

const LEAD_JSON_SHAPE =
  '{"customerName": string, "phone": string, "email": string, "company": string, ' +
  '"requestedService": string, "budget": string, "timeline": string, "location": string, ' +
  '"meetingRequested": string, "callbackRequested": string, "quotationRequested": string, ' +
  '"purchaseIntent": string, "importantNotes": string}';

/** Every field in ChatAgentLeadExtraction/ChatAgentSummary must literally say "Not provided" when genuinely absent -- never a blank string or an invented value. */
const NOT_PROVIDED_INSTRUCTION =
  'For any field with no information in the conversation, write exactly "Not provided" -- never invent a ' +
  "value and never leave a field blank. For meetingRequested/callbackRequested/quotationRequested/" +
  'purchaseIntent, answer "Yes", "No", or "Unclear" based only on what the customer actually said.';

/**
 * Builds the one instruction ("user" turn) sent alongside the system
 * prompt for the requested action. Never includes the raw transcript again
 * here -- that already lives once in the system prompt (buildChatAgentSystemPrompt).
 */
export function buildActionInstruction(input: ChatAgentInput): string {
  switch (input.action) {
    case "summarize":
      return (
        "Summarize this conversation for the staff member reviewing it. Respond with ONLY a single JSON " +
        `object, no prose, no markdown fences, matching exactly: ${SUMMARY_JSON_SHAPE}. ` +
        NOT_PROVIDED_INSTRUCTION +
        ' Use "Not provided" for currentStatus/customerRequest/recommendedNextStep only if genuinely ' +
        "impossible to determine; empty arrays are fine for importantDetails/unansweredQuestions when none apply."
      );

    case "suggest_reply":
      return (
        "Draft ONE customer-ready reply the staff member could send next, based on the conversation above. " +
        "Reply in the customer's own language when it can be determined from the conversation, otherwise use " +
        "the company's fallback language. Keep it concise and natural. Do not promise a meeting, callback, " +
        "quotation, or that a team member was notified unless the context above already proves it is true -- " +
        "if the customer asked for one of these, acknowledge the request without confirming it is done. " +
        "Respond with ONLY the reply text itself -- no preamble, no labels, no quotation marks, no JSON."
      );

    case "rewrite_draft":
      return (
        `Rewrite the staff member's draft reply below in a more "${input.tone}" tone, for the same customer ` +
        "and conversation above. Preserve the exact factual meaning: do not add or remove any promise, price, " +
        "date, or commitment that wasn't already in the draft. Respond with ONLY the rewritten text -- no " +
        "preamble, no labels, no quotation marks, no JSON.\n\n" +
        `Staff draft to rewrite:\n${input.staffDraft}`
      );

    case "translate": {
      const languageName = CHAT_AGENT_SUPPORTED_LANGUAGES[input.targetLanguage!];
      const malayalamGuidance =
        input.targetLanguage === "ml"
          ? " Produce natural, fluent Malayalam -- never a stiff, word-for-word translation. Keep common " +
            "business/product/service terms in English where that is how they are normally used in everyday " +
            "Malayalam business conversation, instead of transliterating them unnecessarily. If the source text " +
            "already mixes Malayalam and English, you may preserve that mixed style."
          : "";
      return (
        `Translate the text below into ${languageName}, preserving its exact original meaning.${malayalamGuidance} ` +
        "Preserve names, prices, currencies, dates, times, phone numbers, URLs, email addresses, company names, " +
        "product names, and brand names exactly as written -- do not localize or alter them. Preserve emojis where they appear, and keep the " +
        "original paragraph structure. Do not add any promise, price, date, meeting confirmation, callback " +
        "confirmation, or any other detail that is not already present in the source text. Respond with ONLY " +
        "the translated text -- no preamble, no labels, no quotation marks, no JSON.\n\n" +
        `Text to translate:\n${input.staffDraft}`
      );
    }

    case "extract_lead":
      return (
        "Extract structured lead information from the conversation above, using only what the customer " +
        `actually said. Respond with ONLY a single JSON object, no prose, no markdown fences, matching ` +
        `exactly: ${LEAD_JSON_SHAPE}. ` +
        NOT_PROVIDED_INSTRUCTION
      );

    case "prepare_follow_up":
      return (
        "Draft a concise follow-up message the staff member could send to re-engage this customer, based on " +
        "the conversation above. Do not claim a meeting is booked, a callback is scheduled, payment was " +
        "received, a quotation was sent, or an agent was assigned unless the context above already proves " +
        "it. Respond with ONLY the follow-up text itself -- no preamble, no labels, no quotation marks, no JSON."
      );

    case "ask_question":
      return (
        `Answer the staff member's question using ONLY the conversation, contact, and lead context above -- ` +
        "never general knowledge, and never anything requiring an internet search. If the answer is not " +
        'present in the available context, respond with exactly: "This information is not present in the ' +
        'available conversation." Respond with ONLY the answer text -- no preamble, no labels, no JSON.\n\n' +
        `Staff member's question: ${input.question}`
      );
  }
}

interface JsonCandidateResult {
  candidate: string;
  /** False when neither a markdown-fenced block nor a `{...}` region could be located at all -- distinct from finding one that then fails to parse. */
  foundJsonRegion: boolean;
}

/**
 * Claude frequently wraps JSON in a markdown fence even when told not to;
 * strips that and falls back to the first {...} substring, mirroring
 * orchestrate.ts's extractJsonCandidate for the customer-reply pipeline
 * (kept as a small separate copy here since that helper isn't exported --
 * both are the same few lines of defensive parsing, not worth a shared
 * cross-cutting export for). Bounded and deterministic: one outer fence
 * strip, one direct-braces scan -- never an open-ended search.
 */
function extractJsonCandidate(rawText: string): JsonCandidateResult {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1] !== undefined) {
    return { candidate: fenced[1].trim(), foundJsonRegion: true };
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return { candidate: trimmed.slice(firstBrace, lastBrace + 1), foundJsonRegion: true };
  }
  return { candidate: trimmed, foundJsonRegion: false };
}

function formatSummary(summary: ChatAgentSummary): string {
  const lines = [
    `Customer request: ${summary.customerRequest || "Not provided"}`,
    "",
    "Important details:",
    ...(summary.importantDetails.length > 0
      ? summary.importantDetails.map((d) => `- ${d}`)
      : ["- Not provided"]),
    "",
    `Current status: ${summary.currentStatus || "Not provided"}`,
    "",
    "Questions still unanswered:",
    ...(summary.unansweredQuestions.length > 0
      ? summary.unansweredQuestions.map((q) => `- ${q}`)
      : ["- None"]),
    "",
    `Recommended next step: ${summary.recommendedNextStep || "Not provided"}`,
  ];
  return lines.join("\n");
}

function formatLeadExtraction(lead: ChatAgentLeadExtraction): string {
  const lines = [
    `Customer name: ${lead.customerName || "Not provided"}`,
    `Phone: ${lead.phone || "Not provided"}`,
    `Email: ${lead.email || "Not provided"}`,
    `Company: ${lead.company || "Not provided"}`,
    `Requested service: ${lead.requestedService || "Not provided"}`,
    `Budget: ${lead.budget || "Not provided"}`,
    `Timeline: ${lead.timeline || "Not provided"}`,
    `Location: ${lead.location || "Not provided"}`,
    `Meeting request: ${lead.meetingRequested || "Not provided"}`,
    `Callback request: ${lead.callbackRequested || "Not provided"}`,
    `Quotation request: ${lead.quotationRequested || "Not provided"}`,
    `Purchase intent: ${lead.purchaseIntent || "Not provided"}`,
    `Important notes: ${lead.importantNotes || "Not provided"}`,
  ];
  return lines.join("\n");
}

export interface ParsedActionResult {
  displayText: string;
  structured?: ChatAgentSummary | ChatAgentLeadExtraction;
}

/**
 * Parses the raw Claude response for the given action. Structured actions
 * (summarize/extract_lead) must be valid JSON matching their schema, or this
 * throws ChatAgentResponseError with a specific stage (empty_response,
 * json_extraction, json_parse, schema_validation, result_serialization) --
 * mapped by the caller to a safe, retryable "incomplete response" message.
 * The raw response text and any extracted field values are never included
 * on the error -- only a character count and, for schema failures, an issue
 * count. Free-text actions are trimmed and used as-is.
 */
export function parseActionResponse(
  action: ChatAgentInput["action"],
  rawText: string,
): ParsedActionResult {
  const responseCharacterCount = rawText.length;

  if (!isStructuredAction(action)) {
    const trimmed = rawText.trim();
    if (!trimmed) throw new ChatAgentResponseError("empty_response", { responseCharacterCount });
    return { displayText: trimmed };
  }

  if (!rawText.trim()) {
    throw new ChatAgentResponseError("empty_response", { responseCharacterCount });
  }

  const { candidate, foundJsonRegion } = extractJsonCandidate(rawText);
  if (!foundJsonRegion) {
    throw new ChatAgentResponseError("json_extraction", { responseCharacterCount });
  }

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    throw new ChatAgentResponseError("json_parse", { responseCharacterCount });
  }

  if (action === "summarize") {
    const result = summarySchema.safeParse(json);
    if (!result.success) {
      throw new ChatAgentResponseError("schema_validation", {
        responseCharacterCount,
        validationIssueCount: result.error.issues.length,
      });
    }
    try {
      return { displayText: formatSummary(result.data), structured: result.data };
    } catch {
      throw new ChatAgentResponseError("result_serialization", { responseCharacterCount });
    }
  }

  const result = leadExtractionSchema.safeParse(json);
  if (!result.success) {
    throw new ChatAgentResponseError("schema_validation", {
      responseCharacterCount,
      validationIssueCount: result.error.issues.length,
    });
  }
  try {
    return { displayText: formatLeadExtraction(result.data), structured: result.data };
  } catch {
    throw new ChatAgentResponseError("result_serialization", { responseCharacterCount });
  }
}
