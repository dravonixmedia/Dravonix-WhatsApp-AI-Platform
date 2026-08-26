import { beforeEach, describe, expect, it, vi } from "vitest";

const getDashboardSession = vi.fn();
vi.mock("../lib/session.js", () => ({
  getDashboardSession: (...args: unknown[]) => getDashboardSession(...args),
}));

let envOverride: Record<string, unknown> = {};
vi.mock("@dravonix/config", () => ({
  loadEnv: () => envOverride,
}));

const createRazorpayOrder = vi.fn();
const verifyRazorpayPaymentSignature = vi.fn();
vi.mock("@dravonix/billing", () => ({
  createRazorpayOrder: (...args: unknown[]) => createRazorpayOrder(...args),
  verifyRazorpayPaymentSignature: (...args: unknown[]) => verifyRazorpayPaymentSignature(...args),
  // Real implementation (not a mock): billing.ts imports this from
  // @dravonix/billing as the one canonical conversion, so the test must
  // exercise the same real rounding behavior rather than a stub.
  toSmallestCurrencyUnit: (decimalAmount: number) => Math.round(decimalAmount * 100),
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

const { createPaymentOrderAction, verifyPaymentCallbackAction } =
  await import("../lib/actions/billing.js");

const SESSION = { userId: "user-1", email: "owner@example.com" };
const CONFIGURED_ENV = {
  razorpayConfigured: true,
  RAZORPAY_KEY_ID: "rzp_test_key_id",
  RAZORPAY_KEY_SECRET: "rzp_test_key_secret",
};

function rpcChain(result: { data: unknown; error: unknown }) {
  return { single: async () => result };
}

beforeEach(() => {
  vi.clearAllMocks();
  envOverride = CONFIGURED_ENV;
  getDashboardSession.mockResolvedValue(SESSION);
});

describe("createPaymentOrderAction", () => {
  it("rejects when there is no session, without ever calling the RPC or Razorpay", async () => {
    getDashboardSession.mockResolvedValue(null);
    const result = await createPaymentOrderAction("invoice-1");
    expect(result.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("refuses to start a payment when Razorpay isn't configured, without calling the RPC", async () => {
    envOverride = { razorpayConfigured: false };
    const result = await createPaymentOrderAction("invoice-1");
    expect(result.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes only the invoice id to create_payment_order -- never a client amount/currency/companyId", async () => {
    rpc.mockReturnValue(rpcChain({ data: null, error: { message: "invoice_not_found" } }));
    await createPaymentOrderAction("invoice-1");
    expect(rpc).toHaveBeenCalledWith("create_payment_order", { p_invoice_id: "invoice-1" });
    expect(rpc.mock.calls[0]?.[1]).toEqual({ p_invoice_id: "invoice-1" });
  });

  it("maps a permission_denied RPC error to a friendly message instead of leaking the raw code", async () => {
    rpc.mockReturnValue(rpcChain({ data: null, error: { message: "permission_denied" } }));
    const result = await createPaymentOrderAction("invoice-1");
    expect(result.success).toBe(false);
    expect(result.error).not.toContain("permission_denied");
  });

  it("on success, creates the Razorpay order using only the RPC's own server-derived amount/currency, then attaches it, and returns only the public key id (never the key secret)", async () => {
    rpc
      .mockReturnValueOnce(
        rpcChain({
          data: {
            payment_id: "payment-1",
            amount: 1000,
            currency: "INR",
            invoice_number: "INV-2026-001",
          },
          error: null,
        }),
      )
      .mockReturnValueOnce(Promise.resolve({ error: null }));
    createRazorpayOrder.mockResolvedValue({
      id: "order_TESTORDER0001",
      amount: 100000,
      currency: "INR",
      receipt: "payment-1",
      status: "created",
    });

    const result = await createPaymentOrderAction("invoice-1");

    expect(createRazorpayOrder).toHaveBeenCalledWith(
      { amountInSmallestUnit: 100000, currency: "INR", receipt: "payment-1" },
      "rzp_test_key_id",
      "rzp_test_key_secret",
    );
    expect(rpc).toHaveBeenCalledWith("attach_razorpay_order", {
      p_payment_id: "payment-1",
      p_razorpay_order_id: "order_TESTORDER0001",
    });
    expect(result).toEqual({
      success: true,
      checkout: {
        keyId: "rzp_test_key_id",
        orderId: "order_TESTORDER0001",
        amount: 100000,
        currency: "INR",
        invoiceNumber: "INV-2026-001",
      },
    });
    expect(JSON.stringify(result)).not.toContain("rzp_test_key_secret");
  });

  it("Migration 29 reuse: when create_payment_order returns an existing_provider_reference, reuses it without ever calling the Razorpay Orders API or attach_razorpay_order", async () => {
    rpc.mockReturnValueOnce(
      rpcChain({
        data: {
          payment_id: "payment-1",
          amount: 1000,
          currency: "INR",
          invoice_number: "INV-2026-001",
          existing_provider_reference: "order_ALREADYATTACHED",
        },
        error: null,
      }),
    );

    const result = await createPaymentOrderAction("invoice-1");

    expect(createRazorpayOrder).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith("attach_razorpay_order", expect.anything());
    expect(result).toEqual({
      success: true,
      checkout: {
        keyId: "rzp_test_key_id",
        orderId: "order_ALREADYATTACHED",
        amount: 100000,
        currency: "INR",
        invoiceNumber: "INV-2026-001",
      },
    });
  });

  it("returns a friendly error and never attaches an order id when Razorpay order creation fails", async () => {
    rpc.mockReturnValueOnce(
      rpcChain({
        data: { payment_id: "payment-1", amount: 1000, currency: "INR", invoice_number: "INV-1" },
        error: null,
      }),
    );
    createRazorpayOrder.mockRejectedValue(new Error("network error"));

    const result = await createPaymentOrderAction("invoice-1");

    expect(result.success).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("verifyPaymentCallbackAction", () => {
  it("returns unverified when there is no session, without calling the signature check", async () => {
    getDashboardSession.mockResolvedValue(null);
    const result = await verifyPaymentCallbackAction("order-1", "pay-1", "sig");
    expect(result.verified).toBe(false);
    expect(verifyRazorpayPaymentSignature).not.toHaveBeenCalled();
  });

  it("returns unverified when Razorpay isn't configured", async () => {
    envOverride = { razorpayConfigured: false };
    const result = await verifyPaymentCallbackAction("order-1", "pay-1", "sig");
    expect(result.verified).toBe(false);
    expect(verifyRazorpayPaymentSignature).not.toHaveBeenCalled();
  });

  it("never writes to the database -- it only checks the signature and revalidates the billing page", async () => {
    verifyRazorpayPaymentSignature.mockResolvedValue(true);
    const result = await verifyPaymentCallbackAction("order-1", "pay-1", "sig");
    expect(result).toEqual({ verified: true });
    expect(rpc).not.toHaveBeenCalled();
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/billing");
  });

  it("propagates a false verification result for a tampered/invalid signature", async () => {
    verifyRazorpayPaymentSignature.mockResolvedValue(false);
    const result = await verifyPaymentCallbackAction("order-1", "pay-1", "bad-sig");
    expect(result.verified).toBe(false);
  });
});
