import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the client-facing dashboard pages against leaking internal
 * implementation language -- repository paths, seed-file references,
 * architecture-decision-record citations, or literal placeholder copy like
 * "Connect a database to list knowledge sources here" -- the exact issue
 * found in the pre-correction Knowledge Base and Settings pages.
 *
 * Comments are stripped before matching: a source comment documenting *why*
 * a decision was made (e.g. "packages/knowledge has no dashboard CRUD
 * module") is legitimate internal documentation and never reaches a
 * rendered page or client bundle, so it must not fail this check the way an
 * actual rendered string would.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSourceWithoutComments(relativePath: string): string {
  const raw = readFileSync(join(webRoot, relativePath), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (leaves "https://" etc. alone)
}

const BANNED_STRINGS = [
  "packages/knowledge",
  "packages/config",
  "supabase/seed/002_demo_tenant.sql",
  "packages/config/src/branding.ts",
  "ADR-0008",
  "Connect a database to list knowledge sources here",
  "Master Prompt section",
  "friendly_professional",
  "text_only_with_notice",
  "META_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
];

const CLIENT_FACING_PAGES = [
  "app/dashboard/knowledge/page.tsx",
  "app/dashboard/settings/page.tsx",
  "app/dashboard/settings/whatsapp/page.tsx",
  "app/dashboard/billing/page.tsx",
  "app/dashboard/page.tsx",
  "app/dashboard/leads/page.tsx",
  "app/dashboard/leads/[leadId]/page.tsx",
  "app/dashboard/ChatAgentPanel.tsx",
  "app/dashboard/ConversationComposerWithAssistant.tsx",
];

describe("client-facing dashboard pages never leak internal implementation language", () => {
  for (const page of CLIENT_FACING_PAGES) {
    it(`${page} contains none of the banned developer strings (outside comments)`, () => {
      const rendered = readSourceWithoutComments(page);
      for (const banned of BANNED_STRINGS) {
        expect(rendered).not.toContain(banned);
      }
    });
  }
});
