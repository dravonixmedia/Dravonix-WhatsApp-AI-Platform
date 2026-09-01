import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static source assertions for the Meta/WhatsApp Batch 1 Super Admin
 * connection management UI (same convention as adminKnowledgeUiWiring.test.ts
 * -- no @testing-library/react in this repo). Behavioral RPC-call correctness
 * is covered dynamically in adminWhatsappConnection.test.ts; this file proves
 * the UI never asks for a credential and never accidentally introduces
 * Embedded Signup.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const rawAdminCompanyPageSource = readFileSync(
  join(webRoot, "app/admin/companies/[id]/page.tsx"),
  "utf8",
);
// Strip comments before the credential/Embedded-Signup ban checks below --
// this batch's own doc comments legitimately name META_ACCESS_TOKEN and
// "Embedded Signup" to explain what this surface deliberately is NOT (see
// whatsappConnectionPage.test.ts's identical convention), which is not the
// same as either ever reaching rendered output or executable code.
const adminCompanyPageSource = rawAdminCompanyPageSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const CREDENTIAL_FIELD_NAMES = [
  "META_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "encrypted_access_token",
  "access_token",
  "app_secret",
];

const EMBEDDED_SIGNUP_TERMS = [
  "embedded_signup",
  "embeddedSignup",
  "Embedded Signup",
  "config_id",
  "FB.login",
  "fbAsyncInit",
  "facebook.net",
  "graph.facebook.com",
  "exchangeCodeForToken",
];

describe("Super Admin WhatsApp connection UI", () => {
  it("imports and binds all four connection actions to the company id", () => {
    for (const action of [
      "adminConnectWhatsappAccountAction",
      "adminConnectWhatsappPhoneNumberAction",
      "adminSetWhatsappAccountStatusAction",
      "adminSetWhatsappPhoneNumberStatusAction",
    ]) {
      expect(adminCompanyPageSource).toContain(action);
    }
    expect(adminCompanyPageSource).toContain(
      "const adminConnectWhatsappAccountWithId = adminConnectWhatsappAccountAction.bind(null, id);",
    );
  });

  it("the connect-WABA form submits waba_id, an optional business_name, and is_test_account -- never a credential field", () => {
    const sectionStart = adminCompanyPageSource.indexOf("Connect a new WhatsApp Business Account");
    expect(sectionStart).toBeGreaterThan(-1);
    const formSection = adminCompanyPageSource.slice(sectionStart, sectionStart + 1200);
    expect(formSection).toContain("action={adminConnectWhatsappAccountWithId}");
    expect(formSection).toContain('name="waba_id"');
    expect(formSection).toContain('name="business_name"');
    expect(formSection).toContain('name="is_test_account"');
  });

  it("the connect-phone form is scoped to its parent account and submits only phone_number_id/display_phone_number", () => {
    const sectionStart = adminCompanyPageSource.indexOf("Connect a phone number to this WABA");
    expect(sectionStart).toBeGreaterThan(-1);
    const formSection = adminCompanyPageSource.slice(sectionStart, sectionStart + 1200);
    expect(formSection).toContain("action={adminConnectWhatsappPhoneNumberWithId}");
    expect(formSection).toContain('name="whatsapp_account_id" value={account.id}');
    expect(formSection).toContain('name="phone_number_id"');
    expect(formSection).toContain('name="display_phone_number"');
  });

  it("account and phone disconnect/reconnect forms submit the toggled status via hidden fields, not free text", () => {
    expect(adminCompanyPageSource).toContain("action={adminSetWhatsappAccountStatusWithId}");
    expect(adminCompanyPageSource).toContain('name="whatsapp_account_id" value={account.id}');
    expect(adminCompanyPageSource).toContain("action={adminSetWhatsappPhoneNumberStatusWithId}");
    expect(adminCompanyPageSource).toContain('name="phone_number_row_id"');
  });

  it("never renders a credential input field or a known secret name anywhere in the WhatsApp section", () => {
    const sectionStart = adminCompanyPageSource.indexOf("WhatsApp connection");
    const nextSectionStart = adminCompanyPageSource.indexOf("Support access sessions");
    const section = adminCompanyPageSource.slice(sectionStart, nextSectionStart);
    for (const name of CREDENTIAL_FIELD_NAMES) {
      expect(section).not.toContain(name);
    }
    expect(section).not.toMatch(/type="password"/);
  });

  it("does not introduce Meta Embedded Signup / OAuth in this batch", () => {
    const sectionStart = adminCompanyPageSource.indexOf("WhatsApp connection");
    const nextSectionStart = adminCompanyPageSource.indexOf("Support access sessions");
    const section = adminCompanyPageSource.slice(sectionStart, nextSectionStart);
    for (const term of EMBEDDED_SIGNUP_TERMS) {
      expect(section).not.toContain(term);
    }
  });

  it("is explicitly labeled as administrative/manual connection management, not Embedded Signup", () => {
    const sectionStart = adminCompanyPageSource.indexOf("WhatsApp connection");
    const nextSectionStart = adminCompanyPageSource.indexOf("Support access sessions");
    const section = adminCompanyPageSource.slice(sectionStart, nextSectionStart);
    expect(section).toContain("Manual administrative connection management");
  });
});
