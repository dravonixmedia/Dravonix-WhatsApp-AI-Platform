import type { RawSearchResult } from "./types.js";

/**
 * Provider-agnostic web research interface (Phase 1: no concrete HTTP
 * implementation exists yet -- see mockProvider.ts for the deterministic
 * test double, and the Phase 1 design report for the vendor evaluation).
 * A future concrete provider (e.g. `providers/<vendor>Provider.ts`, mirroring
 * the pattern already used for AiProvider/SpeechToTextProvider) implements
 * this interface and is selected via an env-gated `*Configured` boolean,
 * exactly like every other external integration in this codebase.
 */
export interface WebResearchProvider {
  search(query: string): Promise<RawSearchResult[]>;
}
