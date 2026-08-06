import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Security-boundary guards for the Dashboard Chat Agent's Server Action
 * (lib/actions/chatAgent.ts). Static source assertions rather than
 * importing the action directly: it transitively imports lib/session.ts,
 * whose getDashboardSession() is wrapped in React's cache() and throws
 * outside Next's server-component runtime (this repo's established
 * convention for exactly this class of file -- see
 * sendHumanReplyGuard.test.ts, serviceRoleGuard.test.ts, navItems.test.ts).
 * Behavioral coverage of the underlying orchestration lives in
 * packages/ai/test/chatAgent/*.test.ts and apps/web/test/chatAgentContext.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const actionSource = readFileSync(join(webRoot, "lib/actions/chatAgent.ts"), "utf8");

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Every "must NOT contain X" assertion below checks the code with comments
// stripped: this file's own doc comments legitimately name things like
// sendHumanReplyAction/audit_logs/serviceRole to explain what the action
// deliberately does NOT do, and comments never execute or ship to a client
// bundle.
const codeOnly = withoutComments(actionSource);

describe("chatAgentAction: authentication and tenant resolution", () => {
  it("authenticates via getDashboardSession before anything else, and rejects when unauthenticated", () => {
    const sessionCallIndex = actionSource.indexOf("await getDashboardSession()");
    const firstDbCallIndex = actionSource.indexOf("createServerSupabaseClient()");
    expect(sessionCallIndex).toBeGreaterThan(-1);
    expect(firstDbCallIndex).toBeGreaterThan(-1);
    expect(sessionCallIndex).toBeLessThan(firstDbCallIndex);
    expect(actionSource).toMatch(
      /if\s*\(!session\)\s*\{\s*return errorResult\("UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE\);/,
    );
  });

  it("never accepts a companyId/tenantId parameter on the action's own input type", () => {
    const interfaceMatch = actionSource.match(
      /export interface ChatAgentActionInput \{([\s\S]*?)\n\}/,
    );
    expect(interfaceMatch).not.toBeNull();
    expect(interfaceMatch?.[1] ?? "").not.toMatch(/companyId|company_id|tenantId|tenant_id/i);
  });

  it("derives the active company only from session.activeCompanyId, never a client-supplied value", () => {
    // Every companyId-shaped argument passed to a repository/service call in
    // this file must be exactly this identifier.
    const companyIdArgs = [
      ...actionSource.matchAll(/(?:companyId|callerCompanyId):\s*([\w.]+)/g),
    ].map((m) => m[1]);
    expect(companyIdArgs.length).toBeGreaterThan(0);
    for (const arg of companyIdArgs) {
      expect(arg).toBe("session.activeCompanyId");
    }
    // Also covers the positional arguments to getConversationThreadForDashboard.
    expect(actionSource).toMatch(
      /getConversationThreadForDashboard\(\s*handoverRepo,\s*session\.activeCompanyId,\s*input\.conversationId,/,
    );
  });
});

describe("chatAgentAction: permission enforcement", () => {
  it("requires conversations.reply (canReplyToConversations) before loading any conversation data", () => {
    const permissionCheckIndex = actionSource.indexOf("capabilities.canReplyToConversations");
    const conversationLoadIndex = actionSource.indexOf("getConversationThreadForDashboard(");
    expect(permissionCheckIndex).toBeGreaterThan(-1);
    expect(conversationLoadIndex).toBeGreaterThan(-1);
    expect(permissionCheckIndex).toBeLessThan(conversationLoadIndex);
    expect(actionSource).toMatch(
      /if\s*\(!capabilities\.canReplyToConversations\)\s*\{\s*return errorResult\("PERMISSION_DENIED", PERMISSION_DENIED_MESSAGE\);/,
    );
  });

  it("never hardcodes a role/email check instead of the real permission function", () => {
    const rendered = withoutComments(actionSource);
    expect(rendered).not.toMatch(/role\s*===?\s*["'](company_owner|company_admin|Admin)["']/);
    expect(rendered).not.toMatch(/["'][\w.+-]+@[\w.-]+\.\w+["']/);
  });
});

describe("chatAgentAction: cross-tenant conversation rejection", () => {
  it("loads the conversation via getConversationThreadForDashboard, which itself rejects a conversation belonging to another company", () => {
    expect(actionSource).toContain("getConversationThreadForDashboard(");
    // Any failure (not found OR cross-tenant) is caught and mapped to one
    // generic, safe result -- existence in another tenant is never
    // distinguishable from "doesn't exist".
    expect(actionSource).toMatch(
      /catch\s*\{\s*[\s\S]{0,300}?return errorResult\("CONVERSATION_NOT_FOUND", CONVERSATION_NOT_FOUND_MESSAGE\);/,
    );
  });

  it("never accepts a raw conversation-history array from the browser -- only a conversationId", () => {
    const interfaceMatch = actionSource.match(
      /export interface ChatAgentActionInput \{([\s\S]*?)\n\}/,
    );
    expect(interfaceMatch?.[1] ?? "").not.toMatch(/messages|history|transcript/i);
  });
});

describe("chatAgentAction: never bypasses the human-review composer", () => {
  it("never imports or calls sendHumanReplyAction or any WhatsApp send path", () => {
    expect(codeOnly).not.toMatch(/sendHumanReplyAction/);
    expect(codeOnly).not.toMatch(/whatsappProvider|WhatsAppProvider|sendText/i);
  });

  it("never imports or calls any handover-lifecycle action (assign/pause/resume/close/mark-read)", () => {
    for (const forbidden of [
      "assignToMeAction",
      "assignToTeamMemberAction",
      "pauseAiAction",
      "resumeAiAction",
      "endHumanAssistanceAction",
      "closeConversationAction",
      "markConversationRead",
    ]) {
      expect(codeOnly).not.toContain(forbidden);
    }
  });

  it("never imports any lead-mutation action", () => {
    expect(codeOnly).not.toMatch(/createLead|updateLead|applyLeadUpdates/);
  });
});

describe("chatAgentAction: never throws -- always returns a structured result", () => {
  it("contains no bare `throw new Error(...)` anywhere in the function body", () => {
    // Next.js redacts a thrown Server Action error in production builds to
    // a generic, undebuggable digest message regardless of how safe the
    // thrown message text is. Every failure path must return a
    // { ok: false, code, message } result instead.
    expect(codeOnly).not.toMatch(/throw new Error\(/);
  });

  it("wraps the entire body in an outer try/catch that still returns a safe result on any unexpected failure", () => {
    expect(actionSource).toMatch(
      /export async function chatAgentAction\([\s\S]*?\{\s*\n\s*const env/,
    );
    expect(actionSource).toMatch(
      /\}\s*catch\s*\{\s*[\s\S]{0,900}?return errorResult\("AI_REQUEST_FAILED", REQUEST_FAILED_MESSAGE\);\s*\n\s*\}\s*\n\}/,
    );
  });

  it("returns { ok: true, ...result } on success, never a bare ChatAgentResult", () => {
    expect(actionSource).toMatch(/return \{ ok: true, \.\.\.result \};/);
  });
});

describe("chatAgentAction: error sanitization and safe error codes", () => {
  it("never returns a raw provider error message to the caller -- only fixed, safe strings", () => {
    expect(actionSource).toMatch(
      /UNAVAILABLE_MESSAGE\s*=\s*"The AI assistant is temporarily unavailable\. Please try again\.";/,
    );
    expect(actionSource).toMatch(
      /BUSY_MESSAGE\s*=\s*"The AI assistant is temporarily busy\. Please try again shortly\.";/,
    );
    expect(actionSource).toMatch(
      /RATE_LIMITED_MESSAGE\s*=\s*"The AI assistant is receiving too many requests\. Please try again shortly\.";/,
    );
    expect(actionSource).toMatch(
      /REQUEST_FAILED_MESSAGE\s*=\s*"The AI assistant could not complete this request\.";/,
    );
  });

  it("maps 429 (rate limited) and 529 (overloaded) to distinct error codes", () => {
    expect(actionSource).toMatch(
      /ChatAgentRateLimitedError[\s\S]{0,160}?return errorResult\("AI_RATE_LIMITED", RATE_LIMITED_MESSAGE\)/,
    );
    expect(actionSource).toMatch(
      /ChatAgentOverloadedError[\s\S]{0,160}?return errorResult\("AI_TEMPORARILY_UNAVAILABLE", BUSY_MESSAGE\)/,
    );
  });

  it("guards against the AI provider not being configured, without calling Anthropic in that case, and returns AI_NOT_CONFIGURED", () => {
    const guardIndex = actionSource.indexOf("!env.anthropicConfigured");
    const providerConstructionIndex = actionSource.indexOf("new AnthropicChatAgentProvider(");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(providerConstructionIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(providerConstructionIndex);
    expect(actionSource).toMatch(
      /!env\.anthropicConfigured[\s\S]{0,120}?return errorResult\("AI_NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE\);/,
    );
  });

  it("never logs SUPABASE_SERVICE_ROLE_KEY, an Anthropic key, or a full system prompt/transcript", () => {
    expect(codeOnly).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(codeOnly).not.toMatch(/log\.\w+\([^)]*system\b/i);
  });

  it("never reads the raw error object when logging an unexpected failure (no error.message/stack forwarded)", () => {
    expect(codeOnly).not.toMatch(/log\.\w+\([^)]*error\.(message|stack)/);
  });
});

describe("chatAgentAction: no schema/migration involvement", () => {
  it("never references audit_logs -- no safe INSERT path exists for this action (see module doc comment)", () => {
    expect(codeOnly).not.toMatch(/audit_logs/);
  });

  it("never imports the service-role client", () => {
    expect(codeOnly).not.toMatch(/serviceRole/i);
  });
});
