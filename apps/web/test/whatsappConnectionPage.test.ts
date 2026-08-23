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
    const selectMatch = pageSource.match(/\.from\("whatsapp_accounts"\)\s*\.select\("([^"]+)"\)/);
    expect(selectMatch).not.toBeNull();
    const columns = (selectMatch?.[1] ?? "").split(",").map((c) => c.trim());
    expect(columns).toEqual([
      "waba_id",
      "business_name",
      "status",
      "is_test_account",
      "last_error",
    ]);
    expect(columns).not.toContain("encrypted_access_token");
  });

  it("masks the WABA id and phone_number_id rather than rendering them in full", () => {
    expect(pageSource).toContain("maskIdentifier(account.waba_id)");
    expect(pageSource).toContain("maskIdentifier(phone.phone_number_id)");
  });

  function actionGuardIndex(): number {
    return pageSource.indexOf("if (!capabilities.canViewWhatsapp) return <PermissionDenied />;");
  }
});
