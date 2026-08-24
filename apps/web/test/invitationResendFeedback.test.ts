import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the Resend/Revoke button fix (same
 * convention as invitationEmailSafety.test.ts -- this repo has no React
 * component-rendering test harness, see notificationBellWiring.test.ts's
 * identical note).
 *
 * Diagnosed bug: the Super Admin company page and Team Settings page each
 * wrapped resendCompanyInvitationAction/revokeCompanyInvitationAction in a
 * bare `<form action={async () => { "use server"; await ...; }}>` that
 * discarded the Server Action's return value entirely -- clicking Resend
 * rotated the invitation token and attempted a real email send (confirmed
 * via staging audit_logs), but nothing in the UI ever showed whether it
 * worked, so the button appeared to do nothing. A rapid double-click also
 * fired two independent resends a few seconds apart with no guard at all,
 * each rotating the token and sending a separate real email (also confirmed
 * via staging audit_logs timestamps 3 seconds apart).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

const actionsSource = readSource("components/InvitationActions.tsx");
const adminPageSource = readSource("app/admin/companies/[id]/page.tsx");
const teamPageSource = readSource("app/dashboard/team/page.tsx");

describe("InvitationActions surfaces the resend/revoke result instead of discarding it", () => {
  it("captures resendCompanyInvitationAction's return value rather than a bare fire-and-forget call", () => {
    expect(actionsSource).toContain(
      "const result = await resendCompanyInvitationAction(invitationId);",
    );
  });

  it("shows the exact success copy when the email was actually sent", () => {
    expect(actionsSource).toContain("Invitation resent successfully.");
  });

  it("shows the exact failure copy when the email was not sent, without exposing the raw provider error", () => {
    expect(actionsSource).toContain("Invitation could not be resent. Please try again.");
    expect(actionsSource).not.toMatch(/errorCode|errorMessage|apiToken/);
  });

  it("branches on emailSent, not merely on whether the action threw", () => {
    expect(actionsSource).toMatch(/result\.emailSent\s*\n?\s*\?\s*\{\s*kind:\s*"success"/);
  });

  it("also surfaces a failure message if the Server Action itself throws (e.g. permission_denied, invitation_not_pending)", () => {
    const tryBlockStart = actionsSource.indexOf("function handleResend");
    const tryBlockEnd = actionsSource.indexOf("function handleRevoke");
    const handleResendBody = actionsSource.slice(tryBlockStart, tryBlockEnd);
    expect(handleResendBody).toContain("} catch {");
    expect(handleResendBody).toContain("Invitation could not be resent. Please try again.");
  });

  it("disables both buttons while a request is pending -- closes off the double-click-sends-two-emails gap at the UI layer", () => {
    const buttonBlocks = [...actionsSource.matchAll(/<button[^]*?<\/button>/g)];
    expect(buttonBlocks.length).toBeGreaterThanOrEqual(2);
    for (const [block] of buttonBlocks) {
      expect(block).toContain("disabled={isPending}");
    }
  });

  it("never reads or renders a token/acceptUrl field off the action result -- only emailSent drives its feedback", () => {
    expect(actionsSource).not.toMatch(/result\.(token|rawToken|acceptUrl|apiKey|apiToken)/i);
  });
});

describe("The Super Admin company page uses the shared InvitationActions component instead of a discarded inline action", () => {
  it("renders <InvitationActions invitationId={...} /> for a pending invitation", () => {
    expect(adminPageSource).toMatch(/<InvitationActions\s+invitationId=\{invitation\.id\}\s*\/>/);
  });

  it("no longer contains the old discarded-result inline resend action", () => {
    expect(adminPageSource).not.toMatch(/"use server";\s*\n\s*await resendCompanyInvitationAction/);
  });

  it("imports InvitationActions from the shared components directory", () => {
    expect(adminPageSource).toMatch(/from ".*components\/InvitationActions\.js"/);
  });
});

describe("The client Team page uses the shared InvitationActions component again (Phase 2 revives team.manage, migration 24)", () => {
  it("renders <InvitationActions invitationId={...} /> for a pending invitation, gated on capabilities.canManageTeam", () => {
    expect(teamPageSource).toMatch(/<InvitationActions\s+invitationId=\{invitation\.id\}\s*\/>/);
    expect(teamPageSource).toContain("capabilities.canManageTeam");
  });

  it("imports InvitationActions from the shared components directory, the same one the Super Admin page uses", () => {
    expect(teamPageSource).toMatch(/from ".*components\/InvitationActions\.js"/);
  });
});
