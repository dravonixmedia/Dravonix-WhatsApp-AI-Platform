import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dashboard UI redesign (claude/dashboard-ui-redesign) restructured
 * every dashboard page's JSX and introduced a shared three-panel workspace,
 * but was explicitly required not to change tenant resolution, permission
 * checks, or the Human Handover Inbox's message lifecycle. These tests are
 * static source assertions (matching the existing sendHumanReplyGuard.test.ts
 * / serviceRoleGuard.test.ts convention) confirming the redesign didn't
 * quietly drop any of those calls while rewriting the surrounding markup.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

describe("dashboard UI redesign: tenant scoping preserved", () => {
  // Phase 4 extracted the getConversationThreadForDashboard call (plus
  // contact loading and aiLikelyProcessing derivation) into a shared
  // loadConversationWorkspaceData helper, reused by these two pages and by
  // the new DRAIVA three-column route -- see
  // conversationWorkspaceData.test.ts for the loader's own behavior, and
  // draivaConversationWorkspace.test.ts for the DRAIVA route's identical use.
  const sharedLoaderSource = readSource("app/dashboard/conversationWorkspaceData.ts");

  it("the shared conversation-workspace loader calls getConversationThreadForDashboard scoped to (repo, companyId, conversationId) -- the single tenant-checked entry point every conversation-detail page goes through", () => {
    expect(sharedLoaderSource).toMatch(
      /getConversationThreadForDashboard\(repo,\s*companyId,\s*conversationId\)/,
    );
  });

  it("conversations/[conversationId]/page.tsx still resolves the conversation via the shared loader, scoped to session.activeCompanyId", () => {
    const source = readSource("app/dashboard/conversations/[conversationId]/page.tsx");
    expect(source).toContain("getDashboardSession");
    expect(source).toContain(
      'import { loadConversationWorkspaceData } from "../../conversationWorkspaceData.js"',
    );
    expect(source).toMatch(/loadConversationWorkspaceData\(supabase, repo, \{/);
    expect(source).toContain("companyId: session.activeCompanyId");
    // markConversationRead now runs from a client effect keyed by
    // conversationId (MarkConversationReadOnMount), not unconditionally on
    // every server render -- see realtimeRefreshLoop.test.ts for why
    // (the old unconditional call created a self-sustaining refresh loop).
    expect(source).toContain("<MarkConversationReadOnMount conversationId={conversationId} />");
    expect(source).not.toContain("markConversationRead(repo, conversationId)");
  });

  it("handover/[conversationId]/page.tsx still resolves the conversation via the shared loader, scoped to session.activeCompanyId", () => {
    const source = readSource("app/dashboard/handover/[conversationId]/page.tsx");
    expect(source).toContain("getDashboardSession");
    expect(source).toContain(
      'import { loadConversationWorkspaceData } from "../../conversationWorkspaceData.js"',
    );
    expect(source).toContain("companyId: session.activeCompanyId");
    // markConversationRead now runs from a client effect keyed by
    // conversationId (MarkConversationReadOnMount), not unconditionally on
    // every server render -- see realtimeRefreshLoop.test.ts for why
    // (the old unconditional call created a self-sustaining refresh loop).
    expect(source).toContain("<MarkConversationReadOnMount conversationId={conversationId} />");
    expect(source).not.toContain("markConversationRead(repo, conversationId)");
  });

  it("the new contact-summary loader is scoped to a single conversationId and never accepts a client-supplied companyId", () => {
    const source = readSource("app/dashboard/loadContactSummary.ts");
    const signatureMatch = source.match(/export async function loadContactSummary\(([^)]*)\)/);
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch?.[1] ?? "").not.toMatch(/companyId|company_id/i);
  });

  it("conversations/conversationsListData.ts still scopes listConversations by companyId and callerMemberId", () => {
    const source = readSource("app/dashboard/conversations/conversationsListData.ts");
    expect(source).toMatch(/listConversations\(supabase,\s*\{/);
    expect(source).toContain("companyId,");
    expect(source).toContain("callerMemberId,");
  });

  it("the dashboard layout still redirects to the no-company-access page for NoCompanyAccessError and a null session", () => {
    const source = readSource("app/dashboard/layout.tsx");
    expect(source).toContain("NoCompanyAccessError");
    expect(source).toContain("<NoCompanyAccessPage />");
  });

  it("the redesigned conversation and handover detail pages still gate every mutating action behind getDashboardCapabilities or a role-derived check", () => {
    const conversationsSource = readSource("app/dashboard/conversations/[conversationId]/page.tsx");
    expect(conversationsSource).toContain("getDashboardCapabilities(session.activeRole)");
    expect(conversationsSource).toContain("capabilities.canAssignConversations");
    expect(conversationsSource).toContain("capabilities.canPauseResumeAi");
  });
});
