import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the reciprocal Conversation -> Lead
 * navigation (P1 dashboard hygiene batch), same convention as
 * navItems.test.ts (no @testing-library/react in this repo).
 * getLeadIdByConversationId's own authorization/lookup logic is covered
 * behaviorally in leadsRepository.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const viewLeadLinkSource = readFileSync(join(webRoot, "app/dashboard/ViewLeadLink.tsx"), "utf8");
const workspaceDataSource = readFileSync(
  join(webRoot, "app/dashboard/conversationWorkspaceData.ts"),
  "utf8",
);
const conversationsPageSource = readFileSync(
  join(webRoot, "app/dashboard/conversations/[conversationId]/page.tsx"),
  "utf8",
);
const handoverPageSource = readFileSync(
  join(webRoot, "app/dashboard/handover/[conversationId]/page.tsx"),
  "utf8",
);
const draivaPageSource = readFileSync(
  join(webRoot, "app/dashboard/draiva/[conversationId]/page.tsx"),
  "utf8",
);
const leadDetailPageSource = readFileSync(
  join(webRoot, "app/dashboard/leads/[leadId]/page.tsx"),
  "utf8",
);

describe("ViewLeadLink", () => {
  it("renders nothing when there is no associated lead -- never a disabled/misleading action", () => {
    expect(viewLeadLinkSource).toContain("if (!leadId) return null;");
  });

  it("links to the existing Lead detail route", () => {
    expect(viewLeadLinkSource).toMatch(/href=\{`\/dashboard\/leads\/\$\{leadId\}`\}/);
  });

  it("never mutates lead state, creates a lead, or infers one by phone matching -- it is a pure, read-only link", () => {
    expect(viewLeadLinkSource).not.toMatch(/\.insert\(|\.update\(|createLead|assignLead/);
  });
});

describe("loadConversationWorkspaceData resolves the associated lead via the explicit relationship, never phone matching", () => {
  it("calls getLeadIdByConversationId scoped to the caller's own company and this conversation", () => {
    expect(workspaceDataSource).toContain(
      "getLeadIdByConversationId(supabase, companyId, conversationId)",
    );
    expect(workspaceDataSource).toContain("leadId");
  });
});

describe("Conversation -> Lead navigation is wired on every conversation-detail-style route", () => {
  it.each([
    ["Live Conversations", conversationsPageSource],
    ["Human Handover", handoverPageSource],
    ["DRAIVA workspace", draivaPageSource],
  ])("%s renders <ViewLeadLink leadId={leadId} />", (_name, source) => {
    expect(source).toContain('import { ViewLeadLink } from "../../ViewLeadLink.js"');
    expect(source).toContain("<ViewLeadLink leadId={leadId} />");
  });
});

describe("Lead -> Conversation regression (existing direction, must remain healthy)", () => {
  it("the Lead detail page still renders a View conversation link when lead.conversationId is set", () => {
    expect(leadDetailPageSource).toContain("lead.conversationId");
    expect(leadDetailPageSource).toMatch(
      /href=\{`\/dashboard\/conversations\/\$\{lead\.conversationId\}`\}/,
    );
  });
});
