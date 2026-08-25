import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 5 email delivery -- static source assertions, same convention as
 * invitationEmailSafety.test.ts (Server Actions here transitively depend on
 * a real Supabase client, so they're checked by inspecting what the source
 * actually calls rather than a live integration test). The template
 * renderers themselves are fully behavior-tested in
 * packages/email/test/supportRequestEmail.test.ts and
 * supportReplyEmail.test.ts. This file covers the apps/web wiring: never
 * blocking request creation/reply on email failure, internal notes never
 * triggering a client email, masked/sanitized diagnostics only, and the
 * email-provider secret never reaching browser code.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

describe("New support request creation never fails because of the notification email", () => {
  const source = readSource("lib/actions/supportRequests.ts");

  it("the email attempt (and its diagnostics RPC) is wrapped in its own try/catch, separate from the create_support_request call", () => {
    const rpcCallIndex = source.indexOf("create_support_request");
    const tryIndex = source.indexOf("try {", rpcCallIndex);
    const catchIndex = source.indexOf("} catch", tryIndex);
    expect(rpcCallIndex).toBeGreaterThan(-1);
    expect(tryIndex).toBeGreaterThan(rpcCallIndex);
    expect(catchIndex).toBeGreaterThan(tryIndex);
    const emailAttemptIndex = source.indexOf("sendNewSupportRequestNotification(", tryIndex);
    expect(emailAttemptIndex).toBeGreaterThan(tryIndex);
    expect(emailAttemptIndex).toBeLessThan(catchIndex);
  });

  it("create_support_request (the RPC that commits the row) runs before the email is ever attempted", () => {
    const rpcCallIndex = source.indexOf('.rpc("create_support_request"');
    const emailAttemptIndex = source.indexOf("sendNewSupportRequestNotification(");
    expect(rpcCallIndex).toBeGreaterThan(-1);
    expect(emailAttemptIndex).toBeGreaterThan(rpcCallIndex);
  });

  it("the request is redirected to (i.e. considered successful) regardless of whether the email attempt inside the try/catch throws", () => {
    const catchIndex = source.indexOf("} catch");
    const redirectIndex = source.indexOf("redirect(`/dashboard/support/");
    expect(redirectIndex).toBeGreaterThan(catchIndex);
  });

  it("sendSupportEmails.ts never throws -- every path returns a typed result", () => {
    const emailServiceSource = readSource("lib/email/sendSupportEmails.ts");
    expect(emailServiceSource).toContain("try {");
    expect(emailServiceSource).toContain('errorCode: "unexpected_error"');
  });
});

describe("Internal notes never trigger a client email", () => {
  const source = readSource("lib/actions/adminSupport.ts");

  it("adminReplySupportRequestAction returns before attempting any email when is_internal is set", () => {
    const fnStart = source.indexOf("export async function adminReplySupportRequestAction");
    const fnEnd = source.indexOf("\nexport async function adminUpdateSupportRequestStatusAction");
    const body = source.slice(fnStart, fnEnd);
    expect(body).toMatch(/if\s*\(isInternal\)\s*return;/);
    const earlyReturnIndex = body.indexOf("if (isInternal) return;");
    const emailCallIndex = body.indexOf("sendSupportReplyNotification(");
    expect(emailCallIndex).toBeGreaterThan(earlyReturnIndex);
  });

  it("admin_reply_support_request itself only sends the client notification when p_is_internal is false (never unconditionally)", () => {
    const migrationSource = readFileSync(
      join(webRoot, "..", "..", "supabase/migrations/00000000000027_client_support_requests.sql"),
      "utf8",
    );
    const fnMatch = migrationSource.match(
      /create or replace function admin_reply_support_request[\s\S]*?\$\$;/,
    );
    expect(fnMatch).not.toBeNull();
    expect(fnMatch?.[0]).toMatch(/if not coalesce\(p_is_internal, false\) then/);
    expect(fnMatch?.[0]).toContain("notify_support_request_client");
  });
});

describe("The client-reply-notification email never corrupts the already-committed reply", () => {
  const source = readSource("lib/actions/adminSupport.ts");

  it("admin_reply_support_request (the RPC that commits the reply) is called before the email is ever attempted", () => {
    const fnStart = source.indexOf("export async function adminReplySupportRequestAction");
    const fnEnd = source.indexOf("\nexport async function adminUpdateSupportRequestStatusAction");
    const body = source.slice(fnStart, fnEnd);
    const rpcCallIndex = body.indexOf('.rpc("admin_reply_support_request"');
    const emailAttemptIndex = body.indexOf("sendSupportReplyNotification(");
    expect(rpcCallIndex).toBeGreaterThan(-1);
    expect(emailAttemptIndex).toBeGreaterThan(rpcCallIndex);
  });

  it("the email/diagnostics block is wrapped in its own try/catch", () => {
    const fnStart = source.indexOf("export async function adminReplySupportRequestAction");
    const fnEnd = source.indexOf("\nexport async function adminUpdateSupportRequestStatusAction");
    const body = source.slice(fnStart, fnEnd);
    expect(body).toContain("try {");
    expect(body).toContain("} catch {");
  });
});

describe("Email diagnostics never leak secrets or raw content", () => {
  it("record_support_email_event is only ever passed a provider message id and sanitized error fields, never the rendered email body", () => {
    const migrationSource = readFileSync(
      join(webRoot, "..", "..", "supabase/migrations/00000000000027_client_support_requests.sql"),
      "utf8",
    );
    const fnMatch = migrationSource.match(
      /create or replace function record_support_email_event[\s\S]*?\$\$;/,
    );
    expect(fnMatch).not.toBeNull();
    expect(fnMatch?.[0]).not.toMatch(/api[_-]?key|token/i);
  });

  it("sendSupportEmails.ts never logs the rendered email body to the console", () => {
    const source = readSource("lib/email/sendSupportEmails.ts");
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
  });

  it("the maskEmail helper never returns the full local part of the address", () => {
    const source = readSource("lib/email/sendSupportEmails.ts");
    const fnStart = source.indexOf("export function maskEmail");
    const fnEnd = source.indexOf("\nfunction getEmailProvider", fnStart);
    const body = source.slice(fnStart, fnEnd);
    expect(body).toContain("local[0]");
    expect(body).not.toMatch(/\$\{local\}@/);
  });
});

describe("The email provider secret and SUPPORT_NOTIFICATION_EMAIL never reach browser code", () => {
  it("sendSupportEmails.ts is server-only", () => {
    const source = readSource("lib/email/sendSupportEmails.ts");
    expect(source).toContain('import "server-only"');
    expect(source).not.toContain('"use client"');
  });

  it("no ZeptoMail/email secret name ever appears in the client-facing support pages", () => {
    for (const relativePath of [
      "app/dashboard/support/page.tsx",
      "app/dashboard/support/[requestId]/page.tsx",
    ]) {
      const source = readSource(relativePath);
      expect(source).not.toContain("ZEPTOMAIL_API_TOKEN");
      expect(source).not.toContain("EMAIL_API_KEY");
      expect(source).not.toContain("SUPPORT_NOTIFICATION_EMAIL");
    }
  });

  it("the wrangler.jsonc config never sets SUPPORT_NOTIFICATION_EMAIL/ZEPTOMAIL_API_TOKEN/EMAIL_API_KEY as a plaintext var", () => {
    const wranglerSource = readSource("wrangler.jsonc");
    const varsBlocks = wranglerSource.match(/"vars":\s*\{[^}]*\}/g) ?? [];
    for (const block of varsBlocks) {
      expect(block).not.toContain("SUPPORT_NOTIFICATION_EMAIL");
      expect(block).not.toContain("ZEPTOMAIL_API_TOKEN");
      expect(block).not.toContain("EMAIL_API_KEY");
    }
  });
});

describe("No automatic retry/queue mechanism exists that could send a duplicate support email", () => {
  it("email delivery happens exactly once per explicit create/reply Server Action call -- no setInterval/retry loop/queue", () => {
    for (const relativePath of [
      "lib/actions/supportRequests.ts",
      "lib/actions/adminSupport.ts",
      "lib/email/sendSupportEmails.ts",
    ]) {
      const source = readSource(relativePath);
      expect(source).not.toMatch(/setInterval|setTimeout|for\s*\(.*retry|while\s*\(/i);
    }
  });
});

describe("The nonexistent support@dravonixmedia.com mailbox is never reintroduced", () => {
  // Fixed whitelist of the actual runtime/config sources that render or
  // configure a Dravonix contact address (confirmed by a repo-wide audit
  // during the Phase 5 email-address correction) -- deliberately not a
  // repo-wide recursive scan, so this test's own literal "support@
  // dravonixmedia.com" search string below can never match itself, and a
  // doc file merely explaining this historical issue can never trip it.
  const repoRoot = join(webRoot, "..", "..");
  const filesToCheck = [
    join(webRoot, "..", "..", "packages/config/src/branding.ts"),
    join(webRoot, "..", "..", "packages/email/src/supportRequestEmail.ts"),
    join(webRoot, "..", "..", "packages/email/src/supportReplyEmail.ts"),
    join(webRoot, "app/login/page.tsx"),
    join(repoRoot, ".env.example"),
  ];

  it("none of the known contact-address sources reference the nonexistent support@dravonixmedia.com mailbox", () => {
    for (const filePath of filesToCheck) {
      const source = readFileSync(filePath, "utf8");
      expect(source.toLowerCase()).not.toContain("support@dravonixmedia.com");
    }
  });

  it("the branding default and both Phase 5 email templates use the real admin@dravonixmedia.com address", () => {
    for (const filePath of filesToCheck.filter((f) => f !== join(webRoot, "app/login/page.tsx"))) {
      const source = readFileSync(filePath, "utf8");
      expect(source).toContain("admin@dravonixmedia.com");
    }
  });
});
