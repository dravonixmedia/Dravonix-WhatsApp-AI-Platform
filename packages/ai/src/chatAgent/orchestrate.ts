import { buildActionInstruction, parseActionResponse, validateChatAgentInput } from "./actions.js";
import { buildChatAgentSystemPrompt } from "./systemPrompt.js";
import type { ChatAgentInput, ChatAgentResult } from "./types.js";
import type { ChatAgentProvider } from "./provider.js";

/**
 * End-to-end Chat Agent turn: validate the action's required fields, build
 * the system prompt (with prompt-injection defense + bounded, authorized
 * context) and the action-specific instruction, call the provider once (no
 * repair-loop, no retry -- a reliable non-streaming single call is the MVP),
 * and parse the result into a uniform, display-ready shape.
 *
 * This function never touches the database, never checks permissions, and
 * never knows about HTTP/Server Actions -- all of that is the caller's job
 * (apps/web/lib/actions/chatAgent.ts). It also never calls anything that
 * could send a WhatsApp message, change handover/AI state, or write to the
 * database -- it only ever returns text for a human to review.
 */
export async function runChatAgentAction(
  provider: ChatAgentProvider,
  input: ChatAgentInput,
): Promise<ChatAgentResult> {
  validateChatAgentInput(input);

  const system = buildChatAgentSystemPrompt(input);
  const instruction = buildActionInstruction(input);
  const rawText = await provider.generateText(system, instruction);
  const parsed = parseActionResponse(input.action, rawText);

  return {
    action: input.action,
    displayText: parsed.displayText,
    structured: parsed.structured,
    historyTruncated: input.historyTruncated,
  };
}
