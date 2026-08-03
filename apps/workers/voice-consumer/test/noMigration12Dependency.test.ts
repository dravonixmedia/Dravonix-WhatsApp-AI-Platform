import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This hotfix branch must stay isolated from the (unmerged, separately
 * staged) migration 12 / Human Handover Inbox schema and RPC family. These
 * symbols only exist once migration 12 is applied -- their absence here is
 * what proves this branch never grew a dependency on it.
 */
const FORBIDDEN_MIGRATION_12_SYMBOLS = [
  "ai_mode",
  "handover_events",
  "00000000000012",
  "reserve_ai_outbound_message",
  "reserve_human_outbound_message",
  "finalize_ai_outbound_message",
  "finalize_human_outbound_message",
  "outbound_status",
];

const FILES_TO_CHECK = [
  "src/processVoiceJob.ts",
  "src/worker.ts",
  "../../../packages/speech/src/malayalamSpeechText.ts",
  "../../../packages/speech/src/providers/elevenLabsTtsProvider.ts",
  "../../../packages/config/src/env.ts",
];

describe("no migration-12 dependency", () => {
  for (const relativePath of FILES_TO_CHECK) {
    it(`${relativePath} does not reference any migration-12 schema or RPC symbol`, () => {
      const content = readFileSync(join(__dirname, "..", relativePath), "utf8");
      for (const symbol of FORBIDDEN_MIGRATION_12_SYMBOLS) {
        expect(content).not.toContain(symbol);
      }
    });
  }
});
