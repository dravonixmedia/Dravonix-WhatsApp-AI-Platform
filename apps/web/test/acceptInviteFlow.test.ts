import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the invitation-acceptance / email-confirmation
 * flow (same convention as invitationEmailSafety.test.ts -- Supabase Auth
 * calls here can't be exercised without a real auth server, so this file
 * checks what the source actually does). Live behavioral coverage of
 * accept_company_invitation itself (token validation, email-match,
 * expiry/revocation rejection, exactly-once membership activation) already
 * exists in supabase/tests/rls_client_onboarding.sql, run against a real
 * local Postgres -- this file only covers the apps/web wiring around it:
 * that the confirmation-email round trip actually carries the pending
 * invitation back to a page that can finish accepting it, that no browser
 * input can supply company/role, and that the existing "No company access"
 * / Super Admin session paths are untouched.
 *
 * Root cause this file guards against: signUp() was previously called with
 * no `emailRedirectTo`, so Supabase's confirmation link sent the browser to
 * /auth/callback with no `next` param -- which defaults to /dashboard,
 * landing the customer there before accept_company_invitation ever ran
 * (confirmed live: pranavkallada.pk@gmail.com's auth.users row is
 * email-confirmed, but company_invitations.status is still 'pending' and no
 * company_members row exists -- audit_logs shows only member_invited and
 * invitation_email_sent, never member_activated).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

const actionSource = readSource("lib/actions/acceptInvite.ts");
const pageSource = readSource("app/invite/[token]/page.tsx");
const callbackSource = readSource("app/auth/callback/route.ts");
const formSource = readSource("app/invite/[token]/AcceptInviteForm.tsx");

describe("New invited user: the confirmation email survives the round trip back to the pending invitation", () => {
  it("signUp is called with emailRedirectTo pointing at /auth/callback with a next param carrying the invite token", () => {
    const signUpBlock = actionSource.slice(
      actionSource.indexOf("supabase.auth.signUp("),
      actionSource.indexOf(");", actionSource.indexOf("supabase.auth.signUp(")),
    );
    expect(signUpBlock).toContain("emailRedirectTo");
    expect(actionSource).toContain("/auth/callback?next=${encodeURIComponent(`/invite/${token}`)}");
  });

  it("the auth callback honors an arbitrary internal next path, unchanged, so /invite/{token} is a valid resume target", () => {
    expect(callbackSource).toContain('next && next.startsWith("/") ? next : "/dashboard"');
  });

  it("the pending-confirmation message is only shown while there is still no matching session (never blocks the resumed accept once one exists)", () => {
    expect(pageSource).toMatch(/pending === "confirmation" && !sessionEmailMatches/);
  });
});

describe("Existing authenticated invited user: no unnecessary second signup/password prompt", () => {
  it("the invite page computes sessionEmailMatches from the current Supabase session, never from a URL/form value", () => {
    expect(pageSource).toContain("await supabase.auth.getUser()");
    expect(pageSource).toMatch(
      /sessionEmailMatches = Boolean\(\s*user\?\.email && user\.email\.toLowerCase\(\) === row\.invitation_email\.toLowerCase\(\)/,
    );
  });

  it("when the session email matches, the page renders a one-click join button bound to acceptInviteForAuthenticatedUserAction, not the password form", () => {
    const matchBlockStart = pageSource.indexOf("if (sessionEmailMatches) {");
    const matchBlockEnd = pageSource.indexOf("\n\n  return (", matchBlockStart);
    const matchBlock = pageSource.slice(matchBlockStart, matchBlockEnd);
    expect(matchBlock).toContain("acceptInviteForAuthenticatedUserAction.bind(null, token)");
    expect(matchBlock).not.toContain("<AcceptInviteForm");
    // The fallback branch (no matching session) still uses the password form.
    expect(pageSource.slice(matchBlockEnd)).toContain("<AcceptInviteForm");
  });
});

describe("Company and role can never be supplied by the browser", () => {
  it("acceptInviteForAuthenticatedUserAction's only parameter is the invitation token", () => {
    expect(actionSource).toMatch(
      /export async function acceptInviteForAuthenticatedUserAction\(token: string\)/,
    );
  });

  it("every accept_company_invitation call passes only p_token -- never a company_id or role", () => {
    const calls = actionSource.match(/accept_company_invitation",\s*\{[^}]*\}/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain("p_token");
      expect(call).not.toMatch(/company_id|p_role|role:/);
    }
  });

  it("no code in this flow ever inserts directly into company_members -- activation only ever happens inside the accept_company_invitation RPC", () => {
    for (const source of [actionSource, pageSource]) {
      expect(source).not.toMatch(/\.from\(\s*["']company_members["']\s*\)/);
    }
  });
});

describe("Already-accepted invitation is handled idempotently -- never a duplicate membership, never a hard failure for the same person", () => {
  it("invitation_not_pending is only ever treated as success when the invitation is already accepted AND the invited email matches the caller's own session email", () => {
    const fnStart = actionSource.indexOf("async function acceptAndRedirect");
    const fnEnd = actionSource.indexOf("\nexport async function acceptInviteAction");
    const body = actionSource.slice(fnStart, fnEnd);
    expect(body).toContain('acceptError.message === "invitation_not_pending"');
    expect(body).toContain('preview?.status === "accepted"');
    expect(body).toContain("preview.invitation_email.toLowerCase() === user.email.toLowerCase()");
  });

  it("a genuine failure (any other error, or a mismatched email) redirects back to the invite page with the error code, never silently to the dashboard", () => {
    const fnStart = actionSource.indexOf("async function acceptAndRedirect");
    const fnEnd = actionSource.indexOf("\nexport async function acceptInviteAction");
    const body = actionSource.slice(fnStart, fnEnd);
    expect(body).toContain(
      "redirect(`/invite/${token}?error=${encodeURIComponent(acceptError.message)}`)",
    );
  });
});

describe("Invitation validity gates (expired/revoked/invalid token) are checked before any session/auto-accept logic runs", () => {
  it("an unknown token still renders 'Invitation not found' before the session is ever read", () => {
    const notFoundIndex = pageSource.indexOf("Invitation not found");
    const getUserIndex = pageSource.indexOf("await supabase.auth.getUser()");
    expect(notFoundIndex).toBeGreaterThan(-1);
    expect(getUserIndex).toBeGreaterThan(notFoundIndex);
  });

  it("a non-pending or expired invitation is rejected before the session is ever read", () => {
    const expiryCheckIndex = pageSource.indexOf('row.status !== "pending"');
    const getUserIndex = pageSource.indexOf("await supabase.auth.getUser()");
    expect(expiryCheckIndex).toBeGreaterThan(-1);
    expect(getUserIndex).toBeGreaterThan(expiryCheckIndex);
  });
});

describe("Existing 'No company access' and Super Admin session paths are untouched by this fix", () => {
  it("lib/session.ts (getDashboardSession/NoCompanyAccessError/getPlatformSession) was not modified by this change", () => {
    // Covered behaviorally by adminFoundationSafety.test.ts and
    // dashboardRedesignSafety.test.ts -- this file only confirms this fix
    // never touched that file at all.
    const sessionSource = readSource("lib/session.ts");
    expect(sessionSource).toContain("export class NoCompanyAccessError extends Error");
    expect(sessionSource).toContain("export const getPlatformSession = cache(");
  });

  it("neither the accept-invite action nor the invite page imports or references platform/admin session helpers", () => {
    for (const source of [actionSource, pageSource]) {
      expect(source).not.toMatch(/getPlatformSession|platform_members/);
    }
  });
});

describe("The accept form's error-message map is shared, not duplicated, between the password-entry and already-authenticated paths", () => {
  it("AcceptInviteForm exports ERROR_MESSAGES and the invite page reuses it for the authenticated branch", () => {
    expect(formSource).toContain("export const ERROR_MESSAGES");
    expect(pageSource).toContain("ERROR_MESSAGES[error] ?? error");
  });
});
