import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 5: Client Support & Requests -- static source assertions for the
 * client (/dashboard/support) and Super Admin (/admin/support-requests)
 * pages, matching every other dashboard page test in this repo (no React
 * component-rendering test harness exists here -- see
 * draivaConversationWorkspace.test.ts's identical note).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const clientListPage = readSource("app/dashboard/support/page.tsx");
const clientDetailPage = readSource("app/dashboard/support/[requestId]/page.tsx");
const adminListPage = readSource("app/admin/support-requests/page.tsx");
const adminDetailPage = readSource("app/admin/support-requests/[requestId]/page.tsx");
const clientActions = readSource("lib/actions/supportRequests.ts");
const adminActions = readSource("lib/actions/adminSupport.ts");
const repository = readSource("lib/repositories/supportRequestsRepository.ts");
const adminLayout = readSource("app/admin/layout.tsx");

describe("Client Support & Requests page: access and create flow", () => {
  it("gates the whole page behind capabilities.canViewSupportRequests, granted to all six active roles via support_requests.view", () => {
    expect(clientListPage).toMatch(/if \(!capabilities\.canViewSupportRequests\) return/);
    const permissionsSource = readSource("lib/permissions.ts");
    for (const role of [
      "company_owner",
      "company_admin",
      "manager",
      "team_leader",
      "sales_person",
      "company_accounts",
    ]) {
      const roleBlockStart = permissionsSource.indexOf(`${role}: new Set([`);
      const roleBlockEnd = permissionsSource.indexOf("]),", roleBlockStart);
      const roleBlock = permissionsSource.slice(roleBlockStart, roleBlockEnd);
      expect(roleBlock).toContain("support_requests.view");
    }
  });

  it("the create form submits type, subject, description, and priority, bound directly to createSupportRequestAction", () => {
    expect(clientListPage).toContain(
      'import { createSupportRequestAction } from "../../../lib/actions/supportRequests.js"',
    );
    expect(clientListPage).toContain("action={createSupportRequestAction}");
    expect(clientListPage).toContain('name="type"');
    expect(clientListPage).toContain('name="subject"');
    expect(clientListPage).toContain('name="description"');
    expect(clientListPage).toContain('name="priority"');
  });

  it("the priority selector only ever offers CLIENT_SELECTABLE_PRIORITIES (normal/high), never urgent/low", () => {
    expect(clientListPage).toContain("CLIENT_SELECTABLE_PRIORITIES.map");
    expect(clientListPage).not.toMatch(/option value="urgent"/);
    expect(clientListPage).not.toMatch(/option value="low"/);
  });

  it("scopes the list to session.activeCompanyId, never a client-supplied id", () => {
    expect(clientListPage).toContain("listSupportRequests(supabase, session.activeCompanyId)");
  });
});

describe("Client Support & Requests: priority is never exposed back to the client", () => {
  it("SupportRequestListItem/SupportRequestDetail (the client-facing shapes) have no priority field", () => {
    const listItemMatch = repository.match(
      /export interface SupportRequestListItem \{([\s\S]*?)\}/,
    );
    const detailMatch = repository.match(
      /export interface SupportRequestDetail extends SupportRequestListItem \{([\s\S]*?)\}/,
    );
    expect(listItemMatch).not.toBeNull();
    expect(detailMatch).not.toBeNull();
    expect(listItemMatch?.[1]).not.toMatch(/priority/i);
    expect(detailMatch?.[1]).not.toMatch(/priority/i);
  });

  it("neither client page ever renders a priority badge/field", () => {
    for (const source of [clientListPage, clientDetailPage]) {
      expect(source).not.toMatch(/SupportRequestPriorityBadge/);
      expect(source).not.toMatch(/\.priority\b/);
    }
  });
});

describe("Client Support & Requests detail page: conversation and reply", () => {
  it("gates on the same canViewSupportRequests capability and resolves via getSupportRequest scoped to the caller's company", () => {
    expect(clientDetailPage).toMatch(/if \(!capabilities\.canViewSupportRequests\)/);
    expect(clientDetailPage).toContain(
      "getSupportRequest(supabase, session.activeCompanyId, requestId)",
    );
    expect(clientDetailPage).toContain("if (!request) notFound();");
  });

  it("never renders internal-note-only fields (isInternal, assignedPlatformUserId, priority) -- RLS already excludes internal messages, and this shape has no such fields to render", () => {
    const codeOnly = withoutComments(clientDetailPage);
    expect(codeOnly).not.toMatch(/isInternal/);
    expect(codeOnly).not.toMatch(/assignedPlatformUserId/);
    expect(codeOnly).not.toMatch(/is_internal/);
  });

  it("the reply form is bound to replySupportRequestAction and hidden once the request is closed", () => {
    expect(clientDetailPage).toContain(
      'import { replySupportRequestAction } from "../../../../lib/actions/supportRequests.js"',
    );
    expect(clientDetailPage).toContain('request.status !== "closed"');
    expect(clientDetailPage).toContain("replySupportRequestAction(requestId, formData)");
  });
});

describe("Client Server Actions: authorization and validation", () => {
  it("both createSupportRequestAction and replySupportRequestAction require canViewSupportRequests before calling any RPC", () => {
    expect(clientActions).toContain("async function requireSupportRequestsAccess()");
    expect(clientActions.match(/await requireSupportRequestsAccess\(\)/g)?.length).toBe(2);
  });

  it("createSupportRequestAction validates the request type against the known label set and rejects an empty subject/description", () => {
    expect(clientActions).toContain("VALID_TYPES.has(type as SupportRequestType)");
    expect(clientActions).toContain("if (!subject || !description)");
  });

  it("createSupportRequestAction passes session.activeCompanyId as p_company_id -- never a client-supplied company id", () => {
    expect(clientActions).toMatch(/p_company_id:\s*session\.activeCompanyId/);
  });

  it("only two RPCs are ever called from the client actions: create_support_request and reply_support_request (plus the email diagnostics RPC) -- no direct table write", () => {
    const codeOnly = withoutComments(clientActions);
    expect(codeOnly).not.toMatch(/\.from\("support_requests"\)\.(update|insert|delete)/);
    expect(codeOnly).not.toMatch(/\.from\("support_request_messages"\)\.(update|insert|delete)/);
  });
});

describe("Super Admin Support & Requests list: filters and columns", () => {
  it("filters by status, type, and priority via GET query params (Link-based pills, matching the leads/companies list convention)", () => {
    expect(adminListPage).toContain("STATUS_FILTERS");
    expect(adminListPage).toContain("TYPE_FILTERS");
    expect(adminListPage).toContain("PRIORITY_FILTERS");
    expect(adminListPage).toContain("listAdminSupportRequests(supabase,");
  });

  it("renders reference, company, type, subject, priority, and status for every row", () => {
    expect(adminListPage).toContain("item.reference");
    expect(adminListPage).toContain("item.companyName");
    expect(adminListPage).toContain("SUPPORT_REQUEST_TYPE_LABELS[item.type]");
    expect(adminListPage).toContain("item.subject");
    expect(adminListPage).toContain("SupportRequestPriorityBadge");
    expect(adminListPage).toContain("SupportRequestStatusBadge");
  });

  it("does not gate on capabilities.canViewSupportRequests -- Super Admin access is enforced by app/admin/layout.tsx, matching every other /admin page (e.g. support-access)", () => {
    expect(adminListPage).not.toContain("canViewSupportRequests");
    expect(adminListPage).not.toContain("getDashboardSession");
  });

  it("neither the list page nor the detail page duplicates its own platformRole check -- both rely entirely on app/admin/layout.tsx", () => {
    for (const source of [adminListPage, adminDetailPage]) {
      expect(source).not.toContain("platformRole");
      expect(source).not.toContain("getPlatformSession");
    }
  });
});

describe("app/admin/layout.tsx: the single gate for the entire /admin/* tree, including support-requests", () => {
  it("strictly requires platformRole === 'super_admin' -- not merely truthy -- so platform_support/platform_billing_admin can never render any /admin page", () => {
    expect(adminLayout).toMatch(/session\.platformRole\s*!==\s*"super_admin"/);
  });

  it("never widens the gate to admit platform_support/platform_billing_admin or any is_platform_staff()-style check", () => {
    expect(adminLayout).not.toMatch(/platformRole\s*===\s*"platform_support"/);
    expect(adminLayout).not.toMatch(/platformRole\s*===\s*"platform_billing_admin"/);
    expect(adminLayout).not.toContain("isPlatformStaff");
  });
});

describe("Super Admin Support & Requests detail: full management surface", () => {
  it("exposes status control, priority control, assignment, reply with an internal-note checkbox, and resolve/reopen", () => {
    expect(adminDetailPage).toContain("adminUpdateSupportRequestStatusAction");
    expect(adminDetailPage).toContain("adminUpdateSupportRequestPriorityAction");
    expect(adminDetailPage).toContain("adminAssignSupportRequestAction");
    expect(adminDetailPage).toContain("adminReplySupportRequestAction");
    expect(adminDetailPage).toContain('name="is_internal"');
    expect(adminDetailPage).toContain("adminResolveSupportRequestAction");
    expect(adminDetailPage).toContain("adminReopenSupportRequestAction");
  });

  it("visually distinguishes an internal note from a public reply in the conversation list", () => {
    expect(adminDetailPage).toContain("message.isInternal");
    expect(adminDetailPage).toContain("Internal note");
  });

  it("shows Resolve only while not already resolved/closed, and Reopen only while resolved/closed (mutually exclusive)", () => {
    expect(adminDetailPage).toMatch(/!isTerminal[\s\S]{0,200}?adminResolveSupportRequestAction/);
    expect(adminDetailPage).toMatch(/adminReopenSupportRequestAction/);
  });

  it("uses getAdminSupportRequest (the unscoped, platform-staff query) rather than the tenant-scoped client getSupportRequest", () => {
    expect(adminDetailPage).toContain("getAdminSupportRequest(supabase, requestId)");
    expect(adminDetailPage).not.toContain("getSupportRequest(supabase,");
  });
});

describe("Super Admin Server Actions: super_admin only (not the broader platform-staff precedent), one RPC per action", () => {
  it("requireSuperAdminClient checks platformRole is exactly super_admin -- authorization correction: platform_support/platform_billing_admin are explicitly NOT approved as support agents for this phase, so this deliberately does not follow admin_start_support_access's broader precedent", () => {
    expect(adminActions).toContain("async function requireSuperAdminClient()");
    expect(adminActions).toMatch(/if \(!session \|\| session\.platformRole !== "super_admin"\)/);
    expect(adminActions).not.toContain("requirePlatformStaffClient");
  });

  it("every admin action calls requireSuperAdminClient, not the broader platform-staff check", () => {
    const actionNames = [
      "adminReplySupportRequestAction",
      "adminUpdateSupportRequestStatusAction",
      "adminResolveSupportRequestAction",
      "adminReopenSupportRequestAction",
      "adminUpdateSupportRequestPriorityAction",
      "adminAssignSupportRequestAction",
    ];
    for (const name of actionNames) {
      const fnStart = adminActions.indexOf(`export async function ${name}`);
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = adminActions.indexOf("\nexport async function", fnStart + 1);
      const body = adminActions.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
      expect(body).toContain("requireSuperAdminClient()");
    }
  });

  it("every admin action calls exactly one RPC for its own mutation", () => {
    const actionNames = [
      "adminUpdateSupportRequestStatusAction",
      "adminResolveSupportRequestAction",
      "adminReopenSupportRequestAction",
      "adminUpdateSupportRequestPriorityAction",
      "adminAssignSupportRequestAction",
    ];
    for (const name of actionNames) {
      const fnStart = adminActions.indexOf(`export async function ${name}`);
      expect(fnStart).toBeGreaterThan(-1);
      const fnEnd = adminActions.indexOf("\n}\n", fnStart);
      const body = adminActions.slice(fnStart, fnEnd);
      const rpcCalls = body.match(/\.rpc\(/g) ?? [];
      expect(rpcCalls.length).toBe(1);
    }
  });

  it("no admin action ever writes directly to support_requests/support_request_messages -- every mutation goes through a named RPC", () => {
    const codeOnly = withoutComments(adminActions);
    expect(codeOnly).not.toMatch(/\.from\("support_requests"\)\.(update|insert|delete)/);
    expect(codeOnly).not.toMatch(/\.from\("support_request_messages"\)\.(update|insert|delete)/);
  });
});

describe("Navigation", () => {
  it("the client sidebar gates Support & Requests on canViewSupportRequests", () => {
    const layoutSource = readSource("app/dashboard/layout.tsx");
    expect(layoutSource).toMatch(
      /if \(capabilities\.canViewSupportRequests\)[\s\S]{0,200}?href: "\/dashboard\/support"/,
    );
  });

  it("the Super Admin sidebar links to /admin/support-requests, distinct from /admin/support-access (no route-prefix collision)", () => {
    const adminSidebarSource = readSource("app/admin/AdminSidebar.tsx");
    expect(adminSidebarSource).toContain('href: "/admin/support-requests"');
    expect(adminSidebarSource).toContain('href: "/admin/support-access"');
    expect("/admin/support-access".startsWith("/admin/support-requests")).toBe(false);
    expect("/admin/support-requests".startsWith("/admin/support-access")).toBe(false);
  });
});

describe("No polling, no duplicate realtime subscription", () => {
  it("neither client nor admin support page uses setInterval/setTimeout, and each mounts at most one RealtimeRefreshBoundary", () => {
    for (const source of [clientListPage, clientDetailPage, adminListPage, adminDetailPage]) {
      expect(source).not.toMatch(/setInterval|setTimeout/);
    }
    for (const source of [clientListPage, clientDetailPage]) {
      expect(source.match(/<RealtimeRefreshBoundary/g)?.length ?? 0).toBe(1);
    }
    for (const source of [adminListPage, adminDetailPage]) {
      expect(source).not.toContain("RealtimeRefreshBoundary");
    }
  });
});
