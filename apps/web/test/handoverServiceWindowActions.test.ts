import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as DravonixHandover from "@dravonix/handover";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for a defect found during Meta/WhatsApp Batch 2's
 * manual staging verification: sendHumanReplyAction/sendServiceWindowTemplateAction
 * used to return `void` and let their expected domain outcomes
 * (WhatsAppServiceWindowClosedError, the RPC's bare "no_fallback_template_configured"
 * string) propagate as thrown Server Action exceptions. Next.js's production
 * build redacts every thrown Server Action error into a generic,
 * undiagnosable "An error occurred in the Server Components render..."
 * digest message -- so a real agent testing this on staging saw that
 * generic error instead of the intended service-window copy, and the
 * "Send re-engagement template" action never appeared (its visibility
 * depended on matching the client-visible error text against the exact
 * WhatsAppServiceWindowClosedError message, which was never actually
 * delivered intact across the Server Action boundary in production).
 *
 * Both actions now catch ONLY their one expected domain error each and
 * return a typed, serializable result instead -- everything else still
 * rethrows unchanged, so this fix never widens what counts as a "safe"
 * outcome.
 */

const getDashboardSession = vi.fn();
vi.mock("../lib/session.js", () => ({
  getDashboardSession: (...args: unknown[]) => getDashboardSession(...args),
}));

let envOverride: Record<string, unknown> = {};
vi.mock("@dravonix/config", () => ({
  loadEnv: () => envOverride,
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

const createServerSupabaseClient = vi.fn(async () => ({}));
vi.mock("../lib/supabase/server.js", () => ({
  createServerSupabaseClient: () => createServerSupabaseClient(),
}));

vi.mock("@dravonix/whatsapp", () => ({
  GraphApiWhatsAppProvider: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../repositories/supabaseEntitlementRepository.js", () => ({
  SupabaseEntitlementRepository: vi.fn().mockImplementation(() => ({})),
}));

function chain(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.single = vi.fn(async () => result);
  builder.maybeSingle = vi.fn(async () => result);
  return builder;
}

const CONVERSATION_ROUTING_ROW = {
  whatsapp_phone_number_id: "phone-row-1",
  contacts: { whatsapp_wa_id: "15551234567" },
  whatsapp_phone_numbers: { phone_number_id: "phone-1", status: "connected" },
};

let phoneNumberRow: unknown = { whatsapp_account_id: "account-1" };
let accountRow: unknown = { service_window_fallback_template_id: "tpl-1" };
let templateRow: unknown = { status: "approved" };

const fromMock = vi.fn((table: string) => {
  switch (table) {
    case "conversations":
      return chain({ data: CONVERSATION_ROUTING_ROW, error: null });
    case "whatsapp_phone_numbers":
      return chain({ data: phoneNumberRow, error: null });
    case "whatsapp_accounts":
      return chain({ data: accountRow, error: null });
    case "whatsapp_templates":
      return chain({ data: templateRow, error: null });
    default:
      return chain({ data: null, error: null });
  }
});
const createServerOnlyServiceRoleClient = vi.fn(() => ({ from: fromMock }));
vi.mock("../lib/supabase/serviceRole.js", () => ({
  createServerOnlyServiceRoleClient: () => createServerOnlyServiceRoleClient(),
}));

const getConversationForThread = vi.fn();
const sendHumanReply = vi.fn();
const sendServiceWindowReengagementTemplate = vi.fn();

vi.mock("@dravonix/handover", async (importOriginal) => {
  const actual = await importOriginal<typeof DravonixHandover>();
  return {
    ...actual,
    sendHumanReply: (...args: unknown[]) => sendHumanReply(...args),
    sendServiceWindowReengagementTemplate: (...args: unknown[]) =>
      sendServiceWindowReengagementTemplate(...args),
    SupabaseHandoverRepository: vi.fn().mockImplementation(() => ({
      getConversationForThread: (...args: unknown[]) => getConversationForThread(...args),
    })),
  };
});

const { sendHumanReplyAction, sendServiceWindowTemplateAction } =
  await import("../lib/actions/handover.js");
const { WhatsAppServiceWindowClosedError, NoServiceWindowFallbackTemplateError } =
  await import("@dravonix/handover");

const SESSION = { activeCompanyId: "company-1", userId: "user-1" };
const CONVERSATION = { id: "conv-1", companyId: "company-1" };

beforeEach(() => {
  vi.clearAllMocks();
  envOverride = { META_ACCESS_TOKEN: "test-token", META_GRAPH_API_VERSION: "v21.0" };
  getDashboardSession.mockResolvedValue(SESSION);
  getConversationForThread.mockResolvedValue(CONVERSATION);
  phoneNumberRow = { whatsapp_account_id: "account-1" };
  accountRow = { service_window_fallback_template_id: "tpl-1" };
  templateRow = { status: "approved" };
});

describe("sendHumanReplyAction", () => {
  it("cross-tenant conversation is rejected before ever calling sendHumanReply (item 8)", async () => {
    getConversationForThread.mockResolvedValue({ id: "conv-1", companyId: "OTHER-COMPANY" });
    await expect(sendHumanReplyAction("conv-1", "hi", "key-1")).rejects.toThrow(
      "Conversation not found or not accessible",
    );
    expect(sendHumanReply).not.toHaveBeenCalled();
  });

  it("a closed service window returns a typed, safe result instead of throwing -- the exact defect this fixes (items 2, 3)", async () => {
    sendHumanReply.mockRejectedValue(new WhatsAppServiceWindowClosedError("conv-1"));

    // The promise must resolve, never reject -- this is what makes it
    // impossible for Next.js's production build to redact this outcome into
    // a generic Server Components digest error.
    const result = await sendHumanReplyAction("conv-1", "hi", "key-1");

    expect(result).toEqual({
      success: false,
      error:
        "The WhatsApp customer service window has expired. An approved template is required before free-form replies can resume.",
      windowClosed: true,
      canSendReengagementTemplate: true,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports canSendReengagementTemplate: false when no approved fallback template is configured (item 6)", async () => {
    accountRow = { service_window_fallback_template_id: null };
    sendHumanReply.mockRejectedValue(new WhatsAppServiceWindowClosedError("conv-1"));

    const result = await sendHumanReplyAction("conv-1", "hi", "key-1");

    expect(result.success).toBe(false);
    expect(result.windowClosed).toBe(true);
    expect(result.canSendReengagementTemplate).toBe(false);
  });

  it("reports canSendReengagementTemplate: false when the configured template is no longer approved", async () => {
    templateRow = { status: "disabled" };
    sendHumanReply.mockRejectedValue(new WhatsAppServiceWindowClosedError("conv-1"));

    const result = await sendHumanReplyAction("conv-1", "hi", "key-1");

    expect(result.canSendReengagementTemplate).toBe(false);
  });

  it("an unexpected/authorization error is rethrown unchanged, never swallowed or reclassified (items 9, 10)", async () => {
    sendHumanReply.mockRejectedValue(new Error("permission_denied"));
    await expect(sendHumanReplyAction("conv-1", "hi", "key-1")).rejects.toThrow(
      "permission_denied",
    );
  });

  it("an inside-window success is unchanged: returns success: true and revalidates (item 11)", async () => {
    sendHumanReply.mockResolvedValue({
      messageId: "msg-1",
      outboundStatus: "sent",
      alreadyHandled: false,
    });

    const result = await sendHumanReplyAction("conv-1", "hi", "key-1");

    expect(result).toEqual({ success: true });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/handover");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/handover/conv-1");
  });
});

describe("sendServiceWindowTemplateAction", () => {
  it("cross-tenant conversation is rejected before ever calling sendServiceWindowReengagementTemplate (item 8)", async () => {
    getConversationForThread.mockResolvedValue({ id: "conv-1", companyId: "OTHER-COMPANY" });
    await expect(sendServiceWindowTemplateAction("conv-1", "key-1")).rejects.toThrow(
      "Conversation not found or not accessible",
    );
    expect(sendServiceWindowReengagementTemplate).not.toHaveBeenCalled();
  });

  it("no fallback template configured returns a typed, safe result instead of throwing the RPC's bare error string (items 5, 6)", async () => {
    sendServiceWindowReengagementTemplate.mockRejectedValue(
      new NoServiceWindowFallbackTemplateError("conv-1"),
    );

    const result = await sendServiceWindowTemplateAction("conv-1", "key-1");

    expect(result).toEqual({
      success: false,
      error:
        "No approved re-engagement template is configured for this WhatsApp number yet. An administrator must configure one before it can be sent.",
      noFallbackConfigured: true,
    });
  });

  it("an unexpected/authorization error is rethrown unchanged (items 9, 10)", async () => {
    sendServiceWindowReengagementTemplate.mockRejectedValue(
      new Error("conversation_not_assigned_to_caller"),
    );
    await expect(sendServiceWindowTemplateAction("conv-1", "key-1")).rejects.toThrow(
      "conversation_not_assigned_to_caller",
    );
  });

  it("a successful send (including a sanitized provider failure or an idempotent duplicate-click no-op, neither of which throws) returns success: true (items 12, 13, 14)", async () => {
    sendServiceWindowReengagementTemplate.mockResolvedValue({
      messageId: "msg-2",
      outboundStatus: "sent",
      alreadyHandled: false,
    });

    const result = await sendServiceWindowTemplateAction("conv-1", "key-1");

    expect(result).toEqual({ success: true });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/handover/conv-1");
  });

  it("never accepts a template id/name from the caller -- only conversationId/idempotencyKey ever reach sendServiceWindowReengagementTemplate (item 7)", async () => {
    sendServiceWindowReengagementTemplate.mockResolvedValue({
      messageId: "msg-2",
      outboundStatus: "sent",
      alreadyHandled: false,
    });

    await sendServiceWindowTemplateAction("conv-1", "key-1");

    const input = sendServiceWindowReengagementTemplate.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(Object.keys(input).sort()).toEqual(
      ["conversationId", "idempotencyKey", "phoneNumberId", "toWaId"].sort(),
    );
  });
});

describe("ReplyComposer.tsx service-window UI wiring (item 4: displays the friendly copy; item 6: no unusable button)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = join(here, "..");
  const composerSource = readFileSync(
    join(webRoot, "app/dashboard/handover/[conversationId]/ReplyComposer.tsx"),
    "utf8",
  );

  it("no longer relies on matching the caught error's message text to decide whether the window is closed", () => {
    // The pre-fix version compared `error === SERVICE_WINDOW_CLOSED_MESSAGE`
    // -- fragile even before this defect, since a Server Action's thrown
    // error message is not guaranteed to survive the client boundary intact.
    expect(composerSource).not.toMatch(/SERVICE_WINDOW_CLOSED_MESSAGE/);
    expect(composerSource).toMatch(/result\.windowClosed/);
    expect(composerSource).toMatch(/result\.canSendReengagementTemplate/);
  });

  it("shows an explanation instead of the send button when no fallback template is available", () => {
    expect(composerSource).toMatch(/No approved re-engagement template is configured/);
  });

  it("never resets the composer or clears the draft on a failed send", () => {
    const failureBranchStart = composerSource.indexOf("if (!result.success) {");
    const failureBranchEnd = composerSource.indexOf("return;", failureBranchStart);
    expect(failureBranchStart).toBeGreaterThan(-1);
    expect(failureBranchEnd).toBeGreaterThan(failureBranchStart);
    const failureBranch = composerSource.slice(failureBranchStart, failureBranchEnd);
    expect(failureBranch).not.toMatch(/formRef\.current\?\.reset\(\)/);
    expect(failureBranch).not.toMatch(/onChange\?\.\(""\)/);
  });
});
