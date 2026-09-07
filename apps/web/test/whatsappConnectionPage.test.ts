import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const rawPageSource = readFileSync(
  join(webRoot, "app/dashboard/settings/whatsapp/page.tsx"),
  "utf8",
);
// Strip comments before the secret-field ban check below -- a comment
// documenting *why* encrypted_access_token is never selected is legitimate
// internal documentation and never reaches the rendered page.
const pageSource = rawPageSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const SECRET_FIELD_NAMES = [
  "encrypted_access_token",
  "META_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
];

describe("WhatsApp connection page", () => {
  it("is gated behind capabilities.canViewWhatsapp before rendering any connection data", () => {
    const gateIndex = actionGuardIndex();
    const queryIndex = pageSource.indexOf('.from("whatsapp_accounts")');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(queryIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(queryIndex);
  });

  it("never selects or renders any known secret field", () => {
    for (const secret of SECRET_FIELD_NAMES) {
      expect(pageSource).not.toContain(secret);
    }
  });

  it("only ever selects the documented safe, non-secret columns from whatsapp_accounts", () => {
    const selectMatch = pageSource.match(
      /\.from\("whatsapp_accounts"\)\s*\.select\(\s*"([^"]+)"\s*,?\s*\)/,
    );
    expect(selectMatch).not.toBeNull();
    const columns = (selectMatch?.[1] ?? "").split(",").map((c) => c.trim());
    // Meta/WhatsApp Batch 3 Slice C added `id` (needed to bind the new
    // client-facing disconnect action to a specific account) and
    // `connection_source` (decides whether Disconnect is offered at all --
    // never for a manual_admin row) -- both plain, non-secret metadata.
    expect(columns).toEqual([
      "id",
      "waba_id",
      "business_name",
      "status",
      "is_test_account",
      "last_error",
      "connection_source",
    ]);
    expect(columns).not.toContain("encrypted_access_token");
  });

  it("masks the WABA id and phone_number_id rather than rendering them in full", () => {
    expect(pageSource).toContain("maskIdentifier(account.waba_id)");
    expect(pageSource).toContain("maskIdentifier(phone.phone_number_id)");
  });

  it("no longer claims Meta App Review is in progress -- App Review is approved (Meta/WhatsApp Batch 1)", () => {
    expect(pageSource).not.toContain("Meta App Review in progress");
    expect(pageSource).not.toContain("Meta App Review is currently in progress");
    // Meta/WhatsApp Batch 3 Slice C: the empty-state copy is now conditional
    // on capabilities.canManageWhatsapp -- a client who can self-connect
    // sees an invitation to do so instead of a pure "contact Dravonix"
    // message. Both variants still exist in the source; this only proves
    // the old Super-Admin-only claim isn't the ONLY copy shown anymore.
    expect(pageSource).toContain(
      "Connect your own WhatsApp Business Account, or contact your Dravonix representative for assisted onboarding.",
    );
  });

  it("Meta/WhatsApp Batch 3 Slice C: connect/disconnect actions now exist, but ONLY behind capabilities.canManageWhatsapp -- never unconditionally, and never for a manual_admin-sourced connection", () => {
    // The real Connect/Reconnect control (FB.login, the code exchange, Graph
    // API verification) is entirely delegated to EmbeddedSignupButton -- see
    // embeddedSignupClientFlow.test.ts for its own dedicated safety
    // coverage. This page's own source contains exactly one <form>: the
    // Disconnect action, gated both by capabilities.canManageWhatsapp and by
    // connection_source === "embedded_signup".
    expect(pageSource).toContain("<EmbeddedSignupButton");
    expect(pageSource).toContain(
      'import { EmbeddedSignupButton } from "./EmbeddedSignupButton.js"',
    );

    const formMatches = pageSource.match(/<form/g) ?? [];
    expect(formMatches).toHaveLength(1);
    const formIndex = pageSource.indexOf("<form");
    const guardWindow = pageSource.slice(0, formIndex);
    expect(guardWindow).toMatch(/capabilities\.canManageWhatsapp[\s\S]*$/);
    expect(guardWindow.slice(guardWindow.lastIndexOf("capabilities.canManageWhatsapp"))).toContain(
      'account.connection_source === "embedded_signup"',
    );
    expect(pageSource).toContain("disconnectWhatsappAccountAction.bind(null, account.id)");
  });

  function actionGuardIndex(): number {
    return pageSource.indexOf("if (!capabilities.canViewWhatsapp) return <PermissionDenied />;");
  }
});
