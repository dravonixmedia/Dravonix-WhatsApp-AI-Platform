import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioral tests for the Meta/WhatsApp Batch 1 Super Admin Server Actions
 * (lib/actions/adminCompanyConfig.ts's WhatsApp connection functions).
 * Dynamically invokes the real exported actions, mocking only their
 * external module boundaries -- the same module-boundary-mocking convention
 * already established by adminKnowledgeIngestion.test.ts/
 * mediaAudioRoute.test.ts in this codebase. The actual authorization/
 * tenant-ownership enforcement lives in the migration 35 RPCs themselves
 * (see supabase/tests/rls_whatsapp_connections.sql) -- these tests prove
 * the action layer calls the right RPC with the right, safely-derived
 * arguments, and never accepts or forwards a credential.
 */

const getPlatformSession = vi.fn();
vi.mock("../lib/session.js", () => ({
  getPlatformSession: (...args: unknown[]) => getPlatformSession(...args),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

const rpc = vi.fn();
const createServerSupabaseClient = vi.fn(async () => ({ rpc }));
vi.mock("../lib/supabase/server.js", () => ({
  createServerSupabaseClient: () => createServerSupabaseClient(),
}));

const {
  adminConnectWhatsappAccountAction,
  adminConnectWhatsappPhoneNumberAction,
  adminSetWhatsappAccountStatusAction,
  adminSetWhatsappPhoneNumberStatusAction,
} = await import("../lib/actions/adminCompanyConfig.js");

const SUPER_ADMIN_SESSION = { platformRole: "super_admin", userId: "staff-1" };
const COMPANY_ID = "company-a";

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  getPlatformSession.mockResolvedValue(SUPER_ADMIN_SESSION);
  rpc.mockResolvedValue({ data: [{ id: "row-1" }], error: null });
});

describe("adminConnectWhatsappAccountAction", () => {
  it("calls admin_connect_whatsapp_account with exactly the submitted fields, never a credential", async () => {
    await adminConnectWhatsappAccountAction(
      COMPANY_ID,
      formData({ waba_id: "WABA123", business_name: "Acme Co", is_test_account: "true" }),
    );

    expect(rpc).toHaveBeenCalledWith("admin_connect_whatsapp_account", {
      p_company_id: COMPANY_ID,
      p_waba_id: "WABA123",
      p_business_name: "Acme Co",
      p_is_test_account: true,
    });
    expect(JSON.stringify(rpc.mock.calls[0]?.[1])).not.toMatch(
      /access_token|app_secret|verify_token/i,
    );
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("rejects without calling the RPC when waba_id is missing", async () => {
    await expect(
      adminConnectWhatsappAccountAction(COMPANY_ID, formData({ business_name: "Acme Co" })),
    ).rejects.toThrow("WABA ID is required");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("unchecked is_test_account is submitted as false, not omitted", async () => {
    await adminConnectWhatsappAccountAction(COMPANY_ID, formData({ waba_id: "WABA123" }));
    expect(rpc).toHaveBeenCalledWith(
      "admin_connect_whatsapp_account",
      expect.objectContaining({ p_is_test_account: false }),
    );
  });

  it("a non-Super-Admin session is rejected before any RPC call", async () => {
    getPlatformSession.mockResolvedValue({ platformRole: "support", userId: "staff-2" });
    await expect(
      adminConnectWhatsappAccountAction(COMPANY_ID, formData({ waba_id: "WABA123" })),
    ).rejects.toThrow("Not authorized");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propagates a cross-company takeover rejection from the RPC rather than swallowing it", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: new Error("waba_already_connected_to_another_company"),
    });
    await expect(
      adminConnectWhatsappAccountAction(COMPANY_ID, formData({ waba_id: "WABA123" })),
    ).rejects.toThrow("waba_already_connected_to_another_company");
  });
});

describe("adminConnectWhatsappPhoneNumberAction", () => {
  it("calls admin_connect_whatsapp_phone_number with exactly the submitted fields", async () => {
    await adminConnectWhatsappPhoneNumberAction(
      COMPANY_ID,
      formData({
        whatsapp_account_id: "account-1",
        phone_number_id: "PHONE123",
        display_phone_number: "+911234567890",
      }),
    );

    expect(rpc).toHaveBeenCalledWith("admin_connect_whatsapp_phone_number", {
      p_company_id: COMPANY_ID,
      p_whatsapp_account_id: "account-1",
      p_phone_number_id: "PHONE123",
      p_display_phone_number: "+911234567890",
    });
  });

  it("rejects without calling the RPC when whatsapp_account_id is missing", async () => {
    await expect(
      adminConnectWhatsappPhoneNumberAction(COMPANY_ID, formData({ phone_number_id: "PHONE123" })),
    ).rejects.toThrow("WhatsApp account is required");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects without calling the RPC when phone_number_id is missing", async () => {
    await expect(
      adminConnectWhatsappPhoneNumberAction(
        COMPANY_ID,
        formData({ whatsapp_account_id: "account-1" }),
      ),
    ).rejects.toThrow("Phone number ID is required");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propagates a mismatched-account rejection from the RPC", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("whatsapp_account_not_found") });
    await expect(
      adminConnectWhatsappPhoneNumberAction(
        COMPANY_ID,
        formData({
          whatsapp_account_id: "account-from-another-company",
          phone_number_id: "PHONE123",
        }),
      ),
    ).rejects.toThrow("whatsapp_account_not_found");
  });
});

describe("adminSetWhatsappAccountStatusAction (disconnect/reconnect)", () => {
  it("calls admin_set_whatsapp_account_status with the submitted status", async () => {
    await adminSetWhatsappAccountStatusAction(
      COMPANY_ID,
      formData({ whatsapp_account_id: "account-1", status: "disabled" }),
    );
    expect(rpc).toHaveBeenCalledWith("admin_set_whatsapp_account_status", {
      p_company_id: COMPANY_ID,
      p_whatsapp_account_id: "account-1",
      p_status: "disabled",
    });
  });

  it("a non-Super-Admin session is rejected before any RPC call", async () => {
    getPlatformSession.mockResolvedValue(null);
    await expect(
      adminSetWhatsappAccountStatusAction(
        COMPANY_ID,
        formData({ whatsapp_account_id: "account-1", status: "disabled" }),
      ),
    ).rejects.toThrow("Not authorized");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("adminSetWhatsappPhoneNumberStatusAction (disconnect/reconnect)", () => {
  it("calls admin_set_whatsapp_phone_number_status with the submitted status", async () => {
    await adminSetWhatsappPhoneNumberStatusAction(
      COMPANY_ID,
      formData({ phone_number_row_id: "phone-1", status: "connected" }),
    );
    expect(rpc).toHaveBeenCalledWith("admin_set_whatsapp_phone_number_status", {
      p_company_id: COMPANY_ID,
      p_phone_number_row_id: "phone-1",
      p_status: "connected",
    });
  });

  it("propagates a whatsapp_account_disabled rejection when reconnecting a phone under a disabled account", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("whatsapp_account_disabled") });
    await expect(
      adminSetWhatsappPhoneNumberStatusAction(
        COMPANY_ID,
        formData({ phone_number_row_id: "phone-1", status: "connected" }),
      ),
    ).rejects.toThrow("whatsapp_account_disabled");
  });

  it("rejects without calling the RPC when phone_number_row_id is missing", async () => {
    await expect(
      adminSetWhatsappPhoneNumberStatusAction(COMPANY_ID, formData({ status: "disabled" })),
    ).rejects.toThrow("Phone number is required");
    expect(rpc).not.toHaveBeenCalled();
  });
});
