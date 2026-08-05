import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards lib/actions/globalSearch.ts's session/length gating. The actual
 * query logic lives in lib/repositories/globalSearchRepository.ts and is
 * covered behaviorally in globalSearchRepository.test.ts; this file can't be
 * imported directly (it transitively pulls in lib/session.ts, whose
 * getDashboardSession() is wrapped in React's cache() and throws outside
 * Next's server-component runtime -- see navItems.test.ts's identical note),
 * so these are static source assertions matching this repo's established
 * convention for exactly this class of file (sendHumanReplyGuard.test.ts,
 * serviceRoleGuard.test.ts).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const actionSource = readFileSync(join(webRoot, "lib/actions/globalSearch.ts"), "utf8");
const repositorySource = readFileSync(
  join(webRoot, "lib/repositories/globalSearchRepository.ts"),
  "utf8",
);

describe("globalSearchAction", () => {
  it("checks the minimum query length before ever touching the session or database", () => {
    const lengthCheckIndex = actionSource.indexOf("term.length < GLOBAL_SEARCH_MIN_LENGTH");
    const sessionCallIndex = actionSource.indexOf("await getDashboardSession()");
    expect(lengthCheckIndex).toBeGreaterThan(-1);
    expect(sessionCallIndex).toBeGreaterThan(-1);
    expect(lengthCheckIndex).toBeLessThan(sessionCallIndex);
  });

  it("requires a minimum of 2 characters", () => {
    // GLOBAL_SEARCH_MIN_LENGTH is defined in globalSearchRepository.ts, not
    // here -- Next.js requires every export from a "use server" file to be
    // an async function, so a plain constant can't live in globalSearch.ts.
    expect(repositorySource).toContain("GLOBAL_SEARCH_MIN_LENGTH = 2");
    expect(actionSource).toContain("GLOBAL_SEARCH_MIN_LENGTH");
  });

  it("derives companyId only from the server-side session, never from the raw query argument", () => {
    const signatureMatch = actionSource.match(
      /export async function globalSearchAction\(([^)]*)\)/,
    );
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch?.[1] ?? "").not.toMatch(/companyId|company_id/i);
    expect(actionSource).toContain("session.activeCompanyId");
  });

  it("returns empty results for a missing session rather than throwing or leaking a partial query", () => {
    expect(actionSource).toMatch(/if\s*\(!session\)\s*return EMPTY_RESULTS;/);
  });

  it('only exports async functions -- Next.js rejects any other export from a "use server" file at build time', () => {
    const exportLines = actionSource.match(/^export .+$/gm) ?? [];
    for (const line of exportLines) {
      expect(line).toMatch(/^export async function/);
    }
  });
});
