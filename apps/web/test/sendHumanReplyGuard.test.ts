import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards sendHumanReplyAction's required-configuration check (apps/web/lib/
 * actions/handover.ts). Diagnosed from a staging incident: META_ACCESS_TOKEN
 * was never provisioned as a Worker secret for dravonix-dashboard-staging,
 * so every human-reply attempt threw "META_ACCESS_TOKEN is not configured"
 * -- surfaced to the browser as Next.js's generic redacted Server Components
 * error. Confirmed via the hosted staging database that this failed
 * *before* any row was written: zero sender_type='human_agent' messages
 * exist for either human_active conversation, despite multiple attempts.
 *
 * These tests encode that safety property as a permanent regression check:
 * the missing-credential guard must always run, and must always run
 * *before* sendHumanReply (which is what actually reserves a message row
 * and calls the WhatsApp provider) -- so a missing/misconfigured credential
 * can never produce a partial reservation or a duplicate send on retry,
 * regardless of how the specific error text or provider changes in future.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const actionPath = join(webRoot, "lib/actions/handover.ts");
const actionSource = readFileSync(actionPath, "utf8");

describe("sendHumanReplyAction required-configuration guard", () => {
  it("checks META_ACCESS_TOKEN is configured and throws if it is not", () => {
    expect(actionSource).toMatch(/if\s*\(\s*!env\.META_ACCESS_TOKEN\s*\)\s*\{/);
    expect(actionSource).toMatch(/throw new Error\("META_ACCESS_TOKEN is not configured"\)/);
  });

  it("runs the META_ACCESS_TOKEN check before calling sendHumanReply, never after", () => {
    // Ordering, not just presence: if a future edit moved the credential
    // check after the reserve/send call, a missing credential would first
    // reserve a message row (and possibly call the WhatsApp provider)
    // before failing -- exactly the partial-write/duplicate-send risk this
    // guard exists to structurally rule out.
    const guardIndex = actionSource.indexOf("META_ACCESS_TOKEN is not configured");
    const sendHumanReplyCallIndex = actionSource.indexOf("await sendHumanReply(");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(sendHumanReplyCallIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(sendHumanReplyCallIndex);
  });

  it("Phase 3A: never reads the SUPABASE_SERVICE_ROLE_KEY env var directly -- only through the audited createServerOnlyServiceRoleClient() wrapper", () => {
    // Updated from this file's original assertion (that the human-reply
    // path never touches service_role at all): the Phase 3A security
    // correction replaced a browser-callable get_conversation_send_target
    // RPC -- which any authenticated caller with conversations.view could
    // invoke directly for any conversation and receive the raw wa_id --
    // with a server-only service-role lookup, gated by an explicit
    // authorization check performed first via the caller's own
    // authenticated session (see the serviceRoleGuard.test.ts ordering
    // test). The invariant this test now encodes is narrower but still
    // load-bearing: this file must never read the raw secret itself,
    // reusing apps/web/lib/supabase/serviceRole.ts's one existing
    // server-only client constructor instead of inventing a second way to
    // reach the service_role key.
    expect(actionSource).not.toMatch(/env\.SUPABASE_SERVICE_ROLE_KEY/);
    expect(actionSource).toMatch(/createServerOnlyServiceRoleClient/);
  });
});
