import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards against the old English/Malayalam-only restriction (or an
 * equivalent paraphrase) ever reappearing in active customer-facing or
 * staff-facing source (final plan section 18). Comments are stripped before
 * matching: a source comment or docstring explaining *why* a past bug
 * happened is legitimate documentation, never a rendered/sent string, so it
 * must not fail this check the way active code would. Test files are
 * intentionally excluded -- asserting the ABSENCE of these phrases (as
 * buildSystemPrompt.test.ts and systemPrompt.test.ts already do) is exactly
 * how the regression is meant to be documented going forward.
 *
 * packages/ai/src/prompt/buildSystemPrompt.ts is deliberately NOT in the
 * swept list below: its fix legitimately contains a negated form of these
 * phrases ("do not claim you can only communicate...") as an instruction
 * TO the model, which a blind substring match can't distinguish from a
 * genuine restriction claim. That file already has its own dedicated,
 * context-aware regex assertions in buildSystemPrompt.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function readSourceWithoutComments(relativePath: string): string {
  const raw = readFileSync(join(repoRoot, relativePath), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (leaves "https://" etc. alone)
}

const BANNED_RESTRICTION_PHRASES = [
  "only English",
  "only Malayalam",
  "English or Malayalam",
  "English/Malayalam",
  "unsupported language",
  "language not supported",
  "can only communicate",
  "can only speak",
];

/**
 * Every source file (never test files) confirmed in the repository-wide
 * multilingual-policy audit to plausibly state DRAIVA's language
 * capability to a customer or to staff advising a customer.
 */
const AUDITED_LANGUAGE_POLICY_SOURCE_FILES = [
  "packages/ai/src/prompt/languagePolicy.ts",
  "packages/ai/src/chatAgent/systemPrompt.ts",
  "packages/ai/src/chatAgent/actions.ts",
  "packages/ai/src/fallbackMessage.ts",
  "packages/ai/src/research/languagePolicy.ts",
  "packages/ai/src/research/webResearchTool.ts",
  "apps/web/app/dashboard/ChatAgentPanel.tsx",
  "apps/web/app/dashboard/draiva/DraivaConversationList.tsx",
  "apps/web/app/dashboard/draiva/DraivaAssistantColumn.tsx",
  "apps/web/lib/repositories/chatAgentContext.ts",
];

describe("no active source contains the old English/Malayalam-only language restriction", () => {
  for (const file of AUDITED_LANGUAGE_POLICY_SOURCE_FILES) {
    it(`${file} contains none of the banned restriction phrases (outside comments)`, () => {
      const source = readSourceWithoutComments(file);
      for (const banned of BANNED_RESTRICTION_PHRASES) {
        // Case-sensitive: the phrases are proper-noun-led (English/Malayalam)
        // or fixed idioms, so a case-sensitive match avoids false positives
        // on unrelated lowercase prose while still catching every real form
        // the restriction has ever taken in this codebase.
        expect(source).not.toContain(banned);
      }
    });
  }
});
