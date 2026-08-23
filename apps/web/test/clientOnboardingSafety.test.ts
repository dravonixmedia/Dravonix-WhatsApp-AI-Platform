import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DRAIVA client onboarding foundation (Phase 17 items 3, 4, 14, 15): static
 * source assertions, same convention as adminFoundationSafety.test.ts --
 * these check structural properties that a live Supabase integration test
 * would otherwise have to re-derive (route gating present, WhatsApp CTA
 * stays disabled, no Meta/Embedded-Signup call exists anywhere in the new
 * surface). Tenant isolation and permission-denial *behavior* itself is
 * covered live against a real local Postgres in
 * supabase/tests/rls_client_onboarding.sql -- this file only checks that the
 * apps/web layer actually calls through to those RPCs/session helpers rather
 * than trusting a client-supplied value.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

describe("WhatsApp connection CTA stays disabled while Meta App Review is in progress", () => {
  it("the dashboard WhatsApp settings page renders a disabled Connect button, never a live one", () => {
    const source = readSource("app/dashboard/settings/whatsapp/page.tsx");
    const buttonBlock = source.match(/<button[\s\S]*?Connect WhatsApp[\s\S]*?<\/button>/);
    expect(buttonBlock).not.toBeNull();
    expect(buttonBlock?.[0]).toContain("disabled");
    expect(buttonBlock?.[0]).not.toContain("onClick");
  });

  it("the Super Admin company detail page renders a disabled Meta onboarding button, never a live one", () => {
    const source = readSource("app/admin/companies/[id]/page.tsx");
    const buttonBlock = source.match(/<button[\s\S]*?Meta WhatsApp onboarding[\s\S]*?<\/button>/);
    expect(buttonBlock).not.toBeNull();
    expect(buttonBlock?.[0]).toContain("disabled");
    expect(buttonBlock?.[0]).not.toContain("onClick");
  });
});

describe("No Meta/Embedded Signup API is called anywhere in the new client onboarding surface", () => {
  const surfaceFiles = [
    "app/dashboard/settings/whatsapp/page.tsx",
    "app/dashboard/onboarding/page.tsx",
    "app/dashboard/team/page.tsx",
    "app/dashboard/team/InviteMemberForm.tsx",
    "app/dashboard/ai-settings/page.tsx",
    "app/dashboard/knowledge/page.tsx",
    "app/invite/[token]/page.tsx",
    "app/invite/[token]/AcceptInviteForm.tsx",
    "lib/actions/invitations.ts",
    "lib/actions/acceptInvite.ts",
    "lib/actions/companyProfile.ts",
    "lib/actions/aiSettings.ts",
    "lib/actions/knowledge.ts",
    "lib/onboarding.ts",
    "app/admin/companies/[id]/page.tsx",
  ];

  // Secret-exposure banned terms (encrypted_access_token, META_ACCESS_TOKEN)
  // are covered separately, with comment-stripping, by
  // settingsPageCleanup.test.ts's "WhatsApp secrets never selected or
  // rendered" -- this list is about Embedded Signup / OAuth calls
  // specifically, none of which appear anywhere in this new surface, not
  // even in prose.
  const bannedTerms = [
    "embedded_signup",
    "embeddedSignup",
    "Embedded Signup",
    "graph.facebook.com",
    "facebook.com/dialog",
    "whatsapp_business_management",
    "generateOAuthUrl",
    "exchangeCodeForToken",
  ];

  it.each(surfaceFiles)("%s never references a Meta OAuth/Embedded Signup call", (relativePath) => {
    const source = readSource(relativePath);
    for (const term of bannedTerms) {
      expect(source).not.toContain(term);
    }
  });
});

describe("Client dashboard access resolves company scope server-side, never from a client-supplied id", () => {
  it("companyProfileAction resolves the company from the session, not from form input", () => {
    const source = readSource("lib/actions/companyProfile.ts");
    expect(source).toContain("getDashboardSession");
    expect(source).toContain("session.activeCompanyId");
    expect(source).not.toMatch(/formData\.get\(\s*["']company_id["']\s*\)/);
  });

  it("invitation/team RPCs accept a caller-supplied company/member id but the RPC itself re-verifies authorization server-side (not a trusted client value) -- these actions add no authorization logic of their own", () => {
    const source = readSource("lib/actions/invitations.ts");
    expect(source).toMatch(
      /create_company_invitation|company_change_member_role|company_deactivate_member/,
    );
    // Explicitly documented in the file itself, not asserted by trusting a
    // client-supplied id -- the RPC's own has_company_permission()/auth.uid()
    // checks are the real boundary (see rls_client_onboarding.sql).
    expect(source).toContain("re-verifies authorization itself");
  });

  it("aiSettings and knowledge actions resolve the company id from the session, never from form input", () => {
    for (const relativePath of ["lib/actions/aiSettings.ts", "lib/actions/knowledge.ts"]) {
      const source = readSource(relativePath);
      expect(source).toContain("getDashboardSession");
      expect(source).toContain("session.activeCompanyId");
      expect(source).not.toMatch(/formData\.get\(\s*["']company_id["']\s*\)/);
    }
  });
});

describe("Onboarding checklist page and Super Admin readiness card share the same pure derivation", () => {
  it("both import computeOnboardingChecklist from lib/onboarding.ts rather than re-implementing the rules", () => {
    const clientPage = readSource("app/dashboard/onboarding/page.tsx");
    const adminPage = readSource("app/admin/companies/[id]/page.tsx");
    expect(clientPage).toContain("computeOnboardingChecklist");
    expect(adminPage).toContain("computeOnboardingChecklist");
  });

  it("neither page auto-flips company.status to active as a side effect of checklist completeness", () => {
    for (const relativePath of [
      "app/dashboard/onboarding/page.tsx",
      "app/admin/companies/[id]/page.tsx",
    ]) {
      const source = readSource(relativePath);
      expect(source).not.toMatch(/status:\s*["']active["']/);
      expect(source).not.toMatch(/\.update\(\s*\{\s*status/);
    }
  });
});

describe("Invitation acceptance never lets email alone determine company access", () => {
  it("acceptCompanyInvitationAction requires an authenticated caller before calling the RPC", () => {
    const source = readSource("lib/actions/invitations.ts");
    const fnSource = source.slice(source.indexOf("acceptCompanyInvitationAction"));
    expect(fnSource).toContain("auth.getUser()");
  });

  it("the migration's accept_company_invitation RPC verifies the caller's own auth.users.email against the invitation, not the reverse", () => {
    const migrationSource = readSource(
      "../../supabase/migrations/00000000000018_client_onboarding.sql",
    );
    const fnSource = migrationSource.slice(
      migrationSource.indexOf("function accept_company_invitation"),
    );
    const bodyEnd = fnSource.indexOf("get_invitation_preview");
    const body = fnSource.slice(0, bodyEnd === -1 ? undefined : bodyEnd);
    expect(body).toContain("auth.uid()");
    expect(body).toMatch(/email_mismatch/);
  });
});

describe("New client onboarding RPCs are hardened the same way as every other RPC in this codebase", () => {
  it("every new RPC sets an empty search_path and is security definer", () => {
    const migrationSource = readSource(
      "../../supabase/migrations/00000000000018_client_onboarding.sql",
    );
    const fnBlocks = migrationSource.split(/create or replace function /g).slice(1);
    expect(fnBlocks.length).toBeGreaterThan(0);
    for (const block of fnBlocks) {
      const upToDollar = block.slice(
        0,
        block.indexOf("$$") === -1 ? block.indexOf("as $") : block.indexOf("$$"),
      );
      expect(upToDollar).toMatch(/security definer/);
      expect(upToDollar).toMatch(/set search_path = ''/);
    }
  });

  it("anon is never granted execute on any function except get_invitation_preview", () => {
    const migrationSource = readSource(
      "../../supabase/migrations/00000000000018_client_onboarding.sql",
    );
    const grantAnonLines = migrationSource
      .split("\n")
      .filter((line) => /grant execute .* to .*anon/.test(line));
    for (const line of grantAnonLines) {
      expect(line).toContain("get_invitation_preview");
    }
  });
});

describe("Super Admin can invite a customer who has no existing DRAIVA Auth account", () => {
  it("the company detail page no longer requires an existing Auth account to invite someone", () => {
    const source = readSource("app/admin/companies/[id]/page.tsx");
    expect(source).not.toContain("Existing Auth user's email");
    expect(source).not.toContain("The invited person must already have a DRAIVA Auth account");
    expect(source).not.toContain("inviteCompanyMemberAction");
  });

  it("reuses the same InviteMemberForm/create_company_invitation flow as the client dashboard's Team Settings page, rather than a second invitation system", () => {
    const source = readSource("app/admin/companies/[id]/page.tsx");
    expect(source).toContain(
      'import { InviteMemberForm } from "../../../dashboard/team/InviteMemberForm.js"',
    );
    expect(source).toContain("<InviteMemberForm");
    expect(source).toContain('defaultRole="company_owner"');
  });

  it("lists invitations with status, created date, expiry, and resend/revoke for pending ones", () => {
    const source = readSource("app/admin/companies/[id]/page.tsx");
    expect(source).toContain('.from("company_invitations")');
    expect(source).toContain("invitation.status");
    expect(source).toContain("invitation.created_at");
    expect(source).toContain("invitation.expires_at");
    // Resend/Revoke live in the shared InvitationActions component (see
    // invitationResendFeedback.test.ts), not as bare action calls in this
    // page's own source.
    expect(source).toMatch(/<InvitationActions\s+invitationId=\{invitation\.id\}\s*\/>/);
  });

  it("existing member management (role change, deactivate) is untouched -- only the invite mechanism changed", () => {
    const source = readSource("app/admin/companies/[id]/page.tsx");
    expect(source).toContain("changeCompanyMemberRoleAction");
    expect(source).toContain("deactivateCompanyMemberAction");
  });
});
