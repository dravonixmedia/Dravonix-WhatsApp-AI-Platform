import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 6B static source assertions for MakePaymentButton.tsx, same
 * convention as phase6CompanyAccountsAccess.test.ts. This client component
 * must never construct or edit any amount/currency/companyId itself -- every
 * value handed to Razorpay's widget must flow through from
 * createPaymentOrderAction's own return value, and the success handler must
 * never itself flip any payment/invoice/subscription state (that only ever
 * happens in the webhook-driven reconcile_razorpay_payment RPC).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

function readSource(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), "utf8");
}

describe("MakePaymentButton.tsx never fabricates payment values client-side", () => {
  const source = readSource("app/dashboard/billing/MakePaymentButton.tsx");

  it("is a client component", () => {
    expect(source).toMatch(/^"use client";/);
  });

  it("only obtains checkout config (keyId/orderId/amount/currency) from createPaymentOrderAction's result, never a locally computed value", () => {
    expect(source).toContain("createPaymentOrderAction(invoiceId)");
    expect(source).toMatch(/key:\s*checkout\.keyId/);
    expect(source).toMatch(/order_id:\s*checkout\.orderId/);
    expect(source).toMatch(/amount:\s*checkout\.amount/);
    expect(source).toMatch(/currency:\s*checkout\.currency/);
  });

  it("never hardcodes or computes an amount/currency/company id itself", () => {
    expect(source).not.toMatch(/amount:\s*\d/);
    expect(source).not.toMatch(/currency:\s*["'][A-Z]{3}["']/);
    expect(source).not.toMatch(/companyId/i);
  });

  it("the Checkout success handler only verifies the signature -- it never calls a mutating RPC or marks anything paid", () => {
    const handlerMatch = source.match(/handler:\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\},/);
    expect(handlerMatch).not.toBeNull();
    const handlerBody = handlerMatch![0];
    expect(handlerBody).toContain("verifyPaymentCallbackAction");
    expect(handlerBody).not.toMatch(/\.rpc\(/);
    expect(handlerBody).not.toMatch(/status\s*=\s*["']paid["']/);
    expect(handlerBody).not.toMatch(/status\s*=\s*["']succeeded["']/);
  });

  it("never sets a payment/invoice as paid/succeeded locally in component state", () => {
    expect(source).not.toMatch(/["']paid["']/);
    expect(source).not.toMatch(/["']succeeded["']/);
  });
});
