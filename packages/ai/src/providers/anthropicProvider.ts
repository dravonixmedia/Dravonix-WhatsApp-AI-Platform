import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../prompt/buildSystemPrompt.js";
import {
  ANTHROPIC_WEB_SEARCH_MAX_USES,
  MAX_SERVER_TOOL_CONTINUATIONS,
  RESEARCH_MAX_TOKENS_MULTIPLIER,
  buildAnthropicResearchCallDiagnostics,
  buildAnthropicWebSearchTool,
  extractResearchExecutionMetadata,
} from "../research/anthropicWebSearch.js";
import type { AiGenerationInput, AiGenerationResult, AiProvider } from "../provider.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Read from ANTHROPIC_MODEL -- never hard-code a "latest" alias (ADR-0004). */
  model: string;
  maxTokens: number;
  /** DRAIVA Research: max web_search invocations per call. Defaults to ANTHROPIC_WEB_SEARCH_MAX_USES (3) -- the conservative staging-pilot ceiling. */
  webSearchMaxUses?: number;
  /** DRAIVA Research: max_tokens for a research-enabled first attempt only. Defaults to maxTokens * RESEARCH_MAX_TOKENS_MULTIPLIER -- see that constant's doc comment for why research needs more headroom than a plain answer. Never applied to a repair attempt. */
  researchMaxTokens?: number;
}

/**
 * Real Anthropic Claude adapter. Selected whenever `env.anthropicConfigured` is
 * true (packages/config). The system prompt (company identity, safety rules,
 * knowledge) is passed as `system`; conversation memory + the customer's
 * message form the message list. A repair instruction, when present, is
 * appended as an additional user turn within the same call rather than a new
 * customer-visible message.
 *
 * DRAIVA Research: when `input.researchEnabled` is true AND this is not a
 * repair attempt, Anthropic's native, server-executed web_search tool
 * (`web_search_20250305`) is attached to the call -- Anthropic runs the
 * search itself within this single request and returns citations/results
 * embedded in the response; there is no separate client-side tool_use round
 * trip to orchestrate. The tool is deliberately NEVER attached to a repair
 * call: a repair's message list does not carry the first attempt's own
 * response forward (see the `messages` construction below), so a second
 * search there would be an independent, uncounted-against-the-turn search --
 * dropping it caps total searches for one customer turn at
 * config.webSearchMaxUses regardless of whether a repair happens.
 *
 * DRAIVA Research -- deterministic intent override: when `input.researchRequired`
 * is ALSO true (research/intentDetector.ts classified the customer's current
 * message as an explicit research request), `tool_choice` is set to force
 * web_search rather than leaving the decision to `auto`. Repeated staging
 * tests showed that prompt instructions alone were not reliably enough to
 * stop the model from silently answering "I don't have confirmed details"
 * for an explicit request -- forcing the tool for these high-confidence
 * cases is a stronger, code-level guarantee than any system-prompt wording
 * can provide. Claude still formulates the query, evaluates results, and
 * synthesizes the final answer -- only whether the tool is invoked at all
 * is no longer left to chance.
 *
 * DRAIVA Research -- pause_turn continuation: Anthropic's server-side search
 * loop can pause a long-running research turn (`stop_reason: "pause_turn"`)
 * before it produces a final answer. Per Anthropic's documented server-tools
 * contract, resuming requires re-sending the paused assistant `content`
 * as-is in a follow-up `messages.create()` call with the same `tools`. A
 * research-enabled call loops through this up to MAX_SERVER_TOOL_CONTINUATIONS
 * times, accumulating every response's content blocks (so search results and
 * citations from every segment are preserved) and every call's token usage.
 * If the turn is still paused after the bound, the accumulated (likely
 * incomplete) text is returned as-is with a `provider_timeout` research
 * failure -- never fabricated, never silently treated as a normal successful
 * answer. This never applies to a repair attempt (no tool is ever attached
 * there) or a plain non-research call (no tool, so Anthropic never pauses).
 */
export class AnthropicProvider implements AiProvider {
  private readonly client: Anthropic;

  constructor(private readonly config: AnthropicProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async generate(
    input: AiGenerationInput,
    repairInstruction?: string,
  ): Promise<AiGenerationResult> {
    const researchEnabled = Boolean(input.researchEnabled) && !repairInstruction;
    const researchRequired = researchEnabled && Boolean(input.researchRequired);
    // Deliberately NOT gated on `!repairInstruction` like researchEnabled above --
    // see buildSystemPrompt's researchFindingsAvailable doc comment. A repair
    // attempt for a turn where research already ran still needs the SAFETY
    // RULES section's company-scope carve-out so it doesn't contradict
    // buildRepairInstruction's injected research-findings recap (orchestrate.ts).
    const researchFindingsAvailable = Boolean(input.researchEnabled);
    const system = buildSystemPrompt(
      input.company,
      input.memory,
      input.knowledge,
      input.temporal,
      researchEnabled,
      researchRequired,
      researchFindingsAvailable,
    );

    const messages: Anthropic.MessageParam[] = [
      ...input.memory.recentMessages.map((m) => ({
        role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
        // A voice note whose transcription is still pending or failed is stored
        // with an empty body; Claude's API rejects any message with empty
        // content outright (400: "user messages must have non-empty content"),
        // which would otherwise hard-fail every future turn in the conversation.
        content: m.body.trim()
          ? m.body
          : "[voice message: transcript unavailable for this one message]",
      })),
      { role: "user", content: input.customerMessage },
    ];

    if (repairInstruction) {
      messages.push({ role: "user", content: repairInstruction });
    }

    // A repair attempt only happens after the first attempt's JSON was
    // invalid/incomplete -- frequently because a high-token-density script
    // (e.g. Malayalam) used up the base budget before finishing the
    // structured response. Give the repair call real extra headroom rather
    // than repeating the same ceiling and risking a second truncation.
    //
    // A research-enabled FIRST attempt gets its own, larger budget for the
    // same underlying reason (see RESEARCH_MAX_TOKENS_MULTIPLIER's doc
    // comment): search-result/citation overhead competes with the
    // structured JSON answer for the same max_tokens ceiling, and a
    // truncated first attempt here is worse than the general case -- it
    // falls through to the repair attempt, which never has the web_search
    // tool attached, silently discarding the search that was actually
    // performed. Checked before the plain researchEnabled branch so a
    // repair attempt (where researchEnabled is already forced false above)
    // can never receive the research budget.
    const maxTokens = repairInstruction
      ? Math.round(this.config.maxTokens * 1.5)
      : researchEnabled
        ? (this.config.researchMaxTokens ??
          Math.round(this.config.maxTokens * RESEARCH_MAX_TOKENS_MULTIPLIER))
        : this.config.maxTokens;

    const webSearchTool = researchEnabled
      ? buildAnthropicWebSearchTool({
          maxUses: this.config.webSearchMaxUses ?? ANTHROPIC_WEB_SEARCH_MAX_USES,
        })
      : null;
    // Force web_search for a deterministically-detected explicit research
    // request instead of leaving it to auto -- see the class doc comment above.
    const webSearchToolChoice =
      researchEnabled && researchRequired
        ? ({
            type: "tool" as const,
            name: "web_search" as const,
          } satisfies Anthropic.ToolChoiceTool)
        : undefined;
    const toolConfig = webSearchTool
      ? {
          tools: [webSearchTool],
          ...(webSearchToolChoice ? { tool_choice: webSearchToolChoice } : {}),
        }
      : {};

    let response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: maxTokens,
      system,
      messages,
      ...toolConfig,
    });

    // Every content block from every call that made up this turn, in order --
    // needed so search results/citations from an earlier, now-superseded
    // pause_turn segment are never lost (see the class doc comment above).
    const allContent: Anthropic.ContentBlock[] = [...response.content];
    let totalInputTokens = response.usage.input_tokens;
    let totalOutputTokens = response.usage.output_tokens;
    let pauseTurnCount = 0;
    let continuationCount = 0;
    // DRAIVA Research staging-only observability (see research/types.ts's
    // AnthropicResearchCallDiagnostics doc comment): tracked alongside the
    // existing token accumulation above, purely additive -- read-only
    // instrumentation on top of the exact same calls already being made,
    // never an extra request and never a change to which requests are made.
    let webSearchRequestsTotal = response.usage.server_tool_use?.web_search_requests ?? 0;
    let webSearchRequestsSeen = response.usage.server_tool_use != null;

    if (researchEnabled) {
      while (
        response.stop_reason === "pause_turn" &&
        continuationCount < MAX_SERVER_TOOL_CONTINUATIONS
      ) {
        pauseTurnCount += 1;
        continuationCount += 1;
        // Resume the SAME turn: re-send the paused assistant content as-is,
        // per Anthropic's documented pattern. Never fabricate a tool_result
        // and never execute web_search ourselves -- Anthropic is the
        // server-side tool executor; this call only lets it continue.
        messages.push({ role: "assistant", content: response.content });
        response = await this.client.messages.create({
          model: this.config.model,
          max_tokens: maxTokens,
          system,
          messages,
          ...toolConfig,
        });
        allContent.push(...response.content);
        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;
        if (response.usage.server_tool_use != null) {
          webSearchRequestsSeen = true;
          webSearchRequestsTotal += response.usage.server_tool_use.web_search_requests;
        }
      }
    }

    // Still paused after the bound -- stop rather than loop further. The
    // (likely incomplete) accumulated text is returned as-is below; it will
    // fail JSON parsing in orchestrate.ts and correctly fall through to the
    // existing repair path, exactly as any other malformed-response case
    // does. Never fabricated, never silently treated as a normal answer.
    const exceededContinuationBound = researchEnabled && response.stop_reason === "pause_turn";

    const rawText = allContent
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const extracted = researchEnabled
      ? extractResearchExecutionMetadata(allContent, new Date())
      : null;

    return {
      rawText,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        // Prompt caching (ADR-0004) is a documented follow-up: the installed SDK
        // version's stable Usage type does not yet surface cache_read_input_tokens
        // outside the beta prompt-caching resource. Wire this up when upgrading.
        cachedInputTokens: 0,
      },
      ...(researchEnabled && extracted
        ? {
            research: {
              ...extracted,
              failureReason: exceededContinuationBound
                ? (extracted.failureReason ?? "provider_timeout")
                : extracted.failureReason,
              pauseTurnCount,
              researchContinuationCount: continuationCount,
            },
            researchDiagnostics: buildAnthropicResearchCallDiagnostics({
              researchRequired,
              researchEnabled,
              model: this.config.model,
              tool: webSearchTool ? { type: webSearchTool.type, name: webSearchTool.name } : null,
              toolChoice: webSearchToolChoice,
              maxTokens,
              allContent,
              finalStopReason: response.stop_reason,
              webSearchRequestsTotal,
              webSearchRequestsSeen,
              pauseTurnCount,
              researchContinuationCount: continuationCount,
              sourceCount: extracted.findings.length,
            }),
          }
        : {}),
    };
  }
}
