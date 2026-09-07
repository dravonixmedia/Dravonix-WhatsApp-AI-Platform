import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Meta/WhatsApp Batch 3, Slice C: static source assertions for the real
 * client-initiated Embedded Signup surface (dashboard/settings/whatsapp),
 * same convention as adminWhatsappConnectionUiWiring.test.ts. This is the
 * dedicated coverage clientOnboardingSafety.test.ts's carve-out comments
 * point to -- it proves the browser-side component never handles a Meta
 * access token, never calls Meta's Graph API directly, and never exchanges
 * the authorization code itself; that all happens server-side in
 * apps/web/app/api/integrations/meta/whatsapp/signup/**.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

/** Strips comments before a banned-term check, same convention as adminWhatsappConnectionUiWiring.test.ts -- a doc comment naming a term to explain what the code deliberately does NOT do is not the same as the term appearing in executable code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const buttonSource = readSource("app/dashboard/settings/whatsapp/EmbeddedSignupButton.tsx");
const buttonSourceNoComments = stripComments(buttonSource);
const pageSource = readSource("app/dashboard/settings/whatsapp/page.tsx");
const initiateRouteSource = readSource(
  "app/api/integrations/meta/whatsapp/signup/initiate/route.ts",
);
const completeRouteSource = readSource(
  "app/api/integrations/meta/whatsapp/signup/complete/route.ts",
);

describe("EmbeddedSignupButton never handles a Meta access token or persists signup state client-side", () => {
  it("never references an access token in any form", () => {
    for (const term of ["accessToken", "access_token", "ACCESS_TOKEN"]) {
      expect(buttonSource).not.toContain(term);
    }
  });

  it("never uses localStorage, sessionStorage, or a cookie to persist signup state", () => {
    expect(buttonSourceNoComments).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it("keeps the attempt id/nonce/code only in in-memory refs, not React state that could be serialized", () => {
    expect(buttonSource).toMatch(/useRef/);
    expect(buttonSource).toContain("attemptRef");
    expect(buttonSource).toContain("codeRef");
  });

  it("never calls Meta's Graph API directly -- only Meta's SDK loader host and this app's own backend routes", () => {
    expect(buttonSource).not.toContain("graph.facebook.com");
    expect(buttonSource).toContain("https://connect.facebook.net/en_US/sdk.js");
    expect(buttonSource).toContain("/api/integrations/meta/whatsapp/signup/initiate");
    expect(buttonSource).toContain("/api/integrations/meta/whatsapp/signup/complete");
  });

  it("never itself performs an OAuth code exchange (no oauth/access_token call, no exchangeCodeForToken)", () => {
    for (const term of ["oauth/access_token", "exchangeCodeForToken", "client_secret"]) {
      expect(buttonSource).not.toContain(term);
    }
  });

  it("validates the postMessage event origin before trusting its payload", () => {
    expect(buttonSource).toContain("isMetaOrigin");
    expect(buttonSource).toMatch(/facebook\.com/);
  });

  it("uses the app's own verified config_id from a NEXT_PUBLIC_ env var, never a hardcoded literal", () => {
    expect(buttonSource).toContain("process.env.NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID");
    expect(buttonSource).not.toMatch(/config_id:\s*["'][0-9]+["']/);
  });
});

describe("The client WhatsApp settings page gates Embedded Signup behind whatsapp.manage", () => {
  it("imports getDashboardCapabilities and never renders the connect control unconditionally", () => {
    expect(pageSource).toContain("getDashboardCapabilities");
    expect(pageSource).toContain("capabilities.canManageWhatsapp");
  });
});

describe("The server-side signup routes require an authenticated session with whatsapp.manage before touching any Meta credential", () => {
  it("both routes resolve authorization via requireWhatsappManageContext before doing anything else", () => {
    for (const source of [initiateRouteSource, completeRouteSource]) {
      expect(source).toContain("requireWhatsappManageContext");
      expect(source).toContain("WhatsappSignupUnauthenticatedError");
    }
  });

  it("neither route trusts a client-supplied company_id -- both derive it from the resolved session", () => {
    for (const source of [initiateRouteSource, completeRouteSource]) {
      expect(source).toContain("session.activeCompanyId");
      expect(source).not.toMatch(/companyId:\s*body\./);
      expect(source).not.toMatch(/company_id:\s*body\./);
    }
  });

  it("the complete route independently verifies phone/WABA ownership via completeEmbeddedSignup rather than trusting the browser-reported pairing", () => {
    expect(completeRouteSource).toContain("completeEmbeddedSignup");
  });

  it("the complete route never logs or returns Meta's raw error text, code exchange body, or the access token -- only EmbeddedSignupFlowError's sanitized code/message", () => {
    expect(completeRouteSource).toContain("EmbeddedSignupFlowError");
    expect(completeRouteSource).toContain("messageForFlowError");
    // accessToken legitimately appears once, as a local parameter name used
    // only to construct the Graph management client -- it must never be
    // passed to logServerError or NextResponse.json.
    expect(completeRouteSource).not.toMatch(/logServerError\([^)]*accessToken/s);
    expect(completeRouteSource).not.toMatch(/NextResponse\.json\([^)]*accessToken/s);
  });

  it("a webhook subscription (or registration) failure never reaches complete_whatsapp_signup as a success -- completeEmbeddedSignup itself throws before persistence", () => {
    const flowSource = readSource("../../packages/whatsapp/src/embeddedSignupFlow.ts");
    const persistCallIndex = flowSource.indexOf("deps.repo.completeAttempt");
    const subscribeCheckIndex = flowSource.indexOf("subscribeAppToWaba");
    const registerCheckIndex = flowSource.indexOf("registerPhoneNumber");
    expect(subscribeCheckIndex).toBeGreaterThan(-1);
    expect(registerCheckIndex).toBeGreaterThan(-1);
    expect(persistCallIndex).toBeGreaterThan(subscribeCheckIndex);
    expect(persistCallIndex).toBeGreaterThan(registerCheckIndex);
  });
});
