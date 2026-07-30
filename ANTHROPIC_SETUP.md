# ANTHROPIC_SETUP.md

## Get an API key

1. Create an account at https://console.anthropic.com.
2. Create an API key.
3. Set `ANTHROPIC_API_KEY` (server/worker-only — never expose to the browser).

## Choosing a model

Set `ANTHROPIC_MODEL` explicitly (defaults to `claude-sonnet-5` in
`packages/config/src/env.ts`). Per ADR-0004, **never** hard-code a "whatever is
latest" alias in application code — verify the exact model ID against the
current Anthropic documentation before a production deployment, since model
IDs and availability change over time. `packages/ai/src/providers/anthropicProvider.ts`
reads the model ID purely from configuration.

## Without an API key

If `ANTHROPIC_API_KEY` is unset, `env.anthropicConfigured` is `false`
(`packages/config/src/env.ts`) and the application should select
`MockAiProvider` (`packages/ai/src/providers/mockProvider.ts`) instead of
`AnthropicProvider` at the composition root. The mock provider returns a
deterministic, schema-valid structured response so the rest of the pipeline
(knowledge retrieval, safety rules, lead extraction, WhatsApp send) can be
developed and tested without any Anthropic spend.

## Verifying the integration

`packages/ai/test/orchestrate.test.ts` and `packages/ai/test/schema.test.ts`
exercise the full validate → repair → fallback pipeline against the mock
provider. To smoke-test against the real API once a key is configured, write a
small script that constructs `AnthropicProvider` directly and calls
`.generate()` with a minimal `AiGenerationInput` — see
`packages/ai/test/fixtures.ts` for a ready-made fixture builder.

## Cost and usage tracking

Every call records `inputTokens`/`outputTokens`/`cachedInputTokens` via
`packages/ai/src/usage.ts`'s `recordAiUsage`, intended to be persisted to the
`usage_events` table (metrics `claude_input_tokens`, `claude_output_tokens`,
`claude_cached_input_tokens`, `claude_requests`) for both cost observability
and plan-limit enforcement (`packages/billing`'s entitlement guard).

## Prompt caching

Anthropic's prompt caching (for the largely-stable system prompt built by
`packages/ai/src/prompt/buildSystemPrompt.ts`) is a documented follow-up: the
currently pinned `@anthropic-ai/sdk` version's stable `Usage` type does not yet
surface `cache_read_input_tokens` outside the beta prompt-caching resource
(see the comment in `packages/ai/src/providers/anthropicProvider.ts`). Wire
this up when upgrading the SDK.
