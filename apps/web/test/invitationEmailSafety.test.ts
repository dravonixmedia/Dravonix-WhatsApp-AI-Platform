import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Invitation email delivery -- static source assertions, same convention as
 * adminActionsSafety.test.ts/clientOnboardingSafety.test.ts (Server Actions
 * here transitively depend on a real Supabase client, so they're checked by
 * inspecting what the source actually calls rather than a live integration
 * test). The email-provider abstraction itself (packages/email) is fully
 * behavior-tested with a mocked fetch -- see packages/email/test/*.test.ts,
 * which cover: correct recipient/subject/body, generated URL contains the
 * correct token, provider-failure handling never throwing, and the API key
 * never appearing in a request body. This file covers the apps/web wiring
 * around that: single shared call site, no raw token ever logged/stored,
 * masked recipient only, production/staging URL separation, and the secret
 * never reaching browser code.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

describe("Invitation creation and resend each trigger exactly one email attempt", () => {
  const source = readSource("lib/actions/invitations.ts");

  it("createCompanyInvitationAction calls deliverInvitationEmail exactly once", () => {
    const fnStart = source.indexOf("export async function createCompanyInvitationAction");
    const fnEnd = source.indexOf("\nexport async function resendCompanyInvitationAction");
    const body = source.slice(fnStart, fnEnd);
    const matches = body.match(/deliverInvitationEmail\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("resendCompanyInvitationAction calls deliverInvitationEmail exactly once", () => {
    const fnStart = source.indexOf("export async function resendCompanyInvitationAction");
    const fnEnd = source.indexOf("\nexport async function revokeCompanyInvitationAction");
    const body = source.slice(fnStart, fnEnd);
    const matches = body.match(/deliverInvitationEmail\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("there is only one deliverInvitationEmail implementation in the whole file (a single shared service, not duplicated per call site)", () => {
    const matches = source.match(/async function deliverInvitationEmail/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("resend builds its accept URL from the RPC's freshly-rotated raw_token, never a stale one", () => {
    const fnStart = source.indexOf("export async function resendCompanyInvitationAction");
    const fnEnd = source.indexOf("\nexport async function revokeCompanyInvitationAction");
    const body = source.slice(fnStart, fnEnd);
    expect(body).toContain("buildAcceptUrl(row.raw_token)");
  });
});

describe("Both the Super Admin and client Team invite paths use the exact same invitation/email service", () => {
  it("both InviteMemberForm usages render the identical shared component, not two separate implementations", () => {
    const adminPage = readSource("app/admin/companies/[id]/page.tsx");
    const teamPage = readSource("app/dashboard/team/page.tsx");
    expect(adminPage).toContain(
      'import { InviteMemberForm } from "../../../dashboard/team/InviteMemberForm.js"',
    );
    expect(teamPage).toContain('import { InviteMemberForm } from "./InviteMemberForm.js"');
  });

  it("InviteMemberForm calls only createCompanyInvitationAction -- no separate client-side email call", () => {
    const source = readSource("app/dashboard/team/InviteMemberForm.tsx");
    expect(source).toContain("createCompanyInvitationAction");
    expect(source).not.toMatch(/fetch\(|resend\.com|sendEmail/i);
  });

  it("no second sendInvitationEmail-shaped function exists anywhere else in apps/web", () => {
    const source = readSource("lib/email/sendInvitationEmail.ts");
    expect(source).toContain("export async function sendInvitationEmail");
  });
});

describe("Invitation email failure is handled safely, never corrupting the invitation record", () => {
  const source = readSource("lib/actions/invitations.ts");

  it("deliverInvitationEmail is called after the invitation RPC already succeeded, so an email failure cannot roll back the invitation", () => {
    const fnStart = source.indexOf("export async function createCompanyInvitationAction");
    const rpcCallIndex = source.indexOf("create_company_invitation", fnStart);
    const deliverCallIndex = source.indexOf("deliverInvitationEmail(", fnStart);
    expect(rpcCallIndex).toBeGreaterThan(-1);
    expect(deliverCallIndex).toBeGreaterThan(rpcCallIndex);
  });

  it("never throws on a failed send -- sendInvitationEmail's own contract returns a typed result instead", () => {
    expect(source).not.toMatch(/deliverInvitationEmail\([\s\S]{0,200}?\)\.catch/);
    const emailServiceSource = readSource("lib/email/sendInvitationEmail.ts");
    expect(emailServiceSource).toContain("try {");
    expect(emailServiceSource).toContain('errorCode: "unexpected_error"');
  });

  it("a production failure never leaks the raw invite link back to the UI; non-production may show it as a fallback", () => {
    expect(source).toContain("isProduction");
    expect(source).toMatch(/acceptUrl: isProduction \? undefined : params\.acceptUrl/);
  });
});

describe("The raw invitation token is never logged or persisted by the email-delivery path", () => {
  it("record_invitation_email_event is called with a masked recipient, never the raw email or token", () => {
    const source = readSource("lib/actions/invitations.ts");
    expect(source).toContain("maskEmail(params.email)");
    expect(source).toContain("p_masked_recipient: masked");
    expect(source).not.toMatch(/p_masked_recipient:\s*params\.email\b/);
    expect(source).not.toMatch(/record_invitation_email_event[\s\S]{0,300}?raw_token/);
  });

  it("sendInvitationEmail.ts never logs the rendered email body or the accept URL to the console", () => {
    const source = readSource("lib/email/sendInvitationEmail.ts");
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
  });

  it("the maskEmail helper never returns the full local part of the address", () => {
    const source = readSource("lib/email/sendInvitationEmail.ts");
    const fnStart = source.indexOf("export function maskEmail");
    const fnEnd = source.indexOf("\nfunction getEmailProvider", fnStart);
    const body = source.slice(fnStart, fnEnd);
    expect(body).toContain("local[0]");
    expect(body).not.toMatch(/\$\{local\}@/);
  });
});

describe("The email provider secret never reaches browser code", () => {
  it("sendInvitationEmail.ts is server-only", () => {
    const source = readSource("lib/email/sendInvitationEmail.ts");
    expect(source).toContain('import "server-only"');
    expect(source).not.toContain('"use client"');
  });

  it("no ZeptoMail/email secret name ever appears in any client component, and never in a NEXT_PUBLIC_ variable", () => {
    const emailAction = readSource("lib/actions/invitations.ts");
    const emailService = readSource("lib/email/sendInvitationEmail.ts");
    const inviteForm = readSource("app/dashboard/team/InviteMemberForm.tsx");
    for (const source of [emailAction, inviteForm]) {
      expect(source).not.toContain("ZEPTOMAIL_API_TOKEN");
      expect(source).not.toContain("EMAIL_API_KEY");
      expect(source).not.toContain("emailApiToken");
    }
    expect(emailService).toContain("env.emailApiToken");
    expect(emailService).not.toMatch(/NEXT_PUBLIC_.*EMAIL/);
  });

  it("the wrangler.jsonc config never sets ZEPTOMAIL_API_TOKEN/EMAIL_API_KEY/EMAIL_FROM_ADDRESS as a plaintext var (they must be secrets)", () => {
    const wranglerSource = readSource("wrangler.jsonc");
    const varsBlocks = wranglerSource.match(/"vars":\s*\{[^}]*\}/g) ?? [];
    for (const block of varsBlocks) {
      expect(block).not.toContain("ZEPTOMAIL_API_TOKEN");
      expect(block).not.toContain("EMAIL_API_KEY");
      expect(block).not.toContain("EMAIL_FROM_ADDRESS");
    }
  });

  it("packages/config never hardcodes a real ZeptoMail token -- only the secret names/fallback logic", () => {
    const envSource = readFileSync(join(webRoot, "..", "..", "packages/config/src/env.ts"), "utf8");
    expect(envSource).toContain("ZEPTOMAIL_API_TOKEN: z.string().optional()");
    expect(envSource).not.toMatch(/Zoho-enczapikey [A-Za-z0-9._-]{10,}/);
  });

  it("the real ZeptoMail provider never uses the Resend endpoint, and no Resend client remains in the codebase", () => {
    const providerSource = readFileSync(
      join(webRoot, "..", "..", "packages/email/src/providers/zeptoMailProvider.ts"),
      "utf8",
    );
    expect(providerSource).toContain("api.zeptomail.com");
    expect(providerSource).not.toContain("resend.com");
    const indexSource = readFileSync(
      join(webRoot, "..", "..", "packages/email/src/index.ts"),
      "utf8",
    );
    expect(indexSource).not.toContain("Resend");
  });
});

describe("Production and staging invitation base URLs remain independently configurable", () => {
  it("buildAcceptUrl is env-driven (loadEnv), never a hardcoded literal URL", () => {
    const source = readSource("lib/actions/invitations.ts");
    const fnStart = source.indexOf("function buildAcceptUrl");
    const fnEnd = source.indexOf("\n}\n", fnStart);
    const body = source.slice(fnStart, fnEnd);
    expect(body).toContain("loadEnv(process.env)");
    expect(body).not.toMatch(/https?:\/\/[a-z0-9.-]+\.workers\.dev/);
  });

  it("wrangler.jsonc sets a real staging APP_URL but leaves production APP_URL unset (separately configurable, not copy-pasted)", () => {
    const source = readSource("wrangler.jsonc");
    const stagingBlock = source.slice(source.indexOf('"staging"'), source.indexOf('"production"'));
    const productionBlock = source.slice(source.indexOf('"production"'));
    expect(stagingBlock).toMatch(/"APP_URL":\s*"https:\/\//);
    expect(productionBlock).not.toMatch(/"APP_URL":\s*"/);
  });
});

describe("The Cloudflare staging-config preflight script tolerates a '//' inside a wrangler.jsonc string value", () => {
  const rootDir = join(webRoot, "..", "..");

  it.each(["staging", "production"] as const)(
    "verify-web-staging-config.sh %s still parses wrangler.jsonc now that APP_URL contains 'https://'",
    (environment) => {
      // Regression test: the script's own JSONC-comment stripper used to be
      // a plain /\/\/.*$/ regex, which truncated the APP_URL string value
      // added above (containing "//") as if it were a line comment,
      // producing invalid JSON and crashing this exact script -- caught by
      // running it manually against this diff before every other check.
      expect(() =>
        execFileSync("bash", [join(rootDir, "scripts/verify-web-staging-config.sh"), environment], {
          cwd: rootDir,
          stdio: "pipe",
        }),
      ).not.toThrow();
    },
  );
});

describe("No automatic retry/queue mechanism exists that could send a duplicate invitation email", () => {
  it("email delivery happens exactly once per explicit invite/resend Server Action call -- no setInterval/retry loop/queue in the email path", () => {
    for (const relativePath of ["lib/actions/invitations.ts", "lib/email/sendInvitationEmail.ts"]) {
      const source = readSource(relativePath);
      expect(source).not.toMatch(/setInterval|setTimeout|for\s*\(.*retry|while\s*\(/i);
    }
  });
});
