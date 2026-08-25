"use server";

/**
 * Phase 6B: Razorpay Order creation + Checkout signature verification.
 * Every mutating step (creating the pending payment row, attaching the
 * Razorpay order id) goes through a SECURITY DEFINER RPC that re-derives
 * the caller's company from the invoice row itself and re-checks
 * billing.pay server-side -- this file never trusts a client-supplied
 * company_id, amount, or currency; both are always the invoice's own
 * server-stored values (see create_payment_order, migration 28).
 *
 * The actual payment/invoice/subscription state transition never happens
 * here: it happens exactly once, idempotently, in reconcile_razorpay_payment
 * (service_role only, invoked from the webhook handler in apps/api). This
 * file's verifyPaymentCallbackAction only checks the Checkout signature for
 * fast, honest client feedback -- it is not proof of payment and never
 * writes to any table.
 */

import { loadEnv } from "@dravonix/config";
import {
  createRazorpayOrder,
  toSmallestCurrencyUnit,
  verifyRazorpayPaymentSignature,
} from "@dravonix/billing";
import { revalidatePath } from "next/cache";
import { getDashboardSession } from "../session.js";
import { createServerSupabaseClient } from "../supabase/server.js";

export interface CreatePaymentOrderResult {
  success: boolean;
  error?: string;
  checkout?: {
    keyId: string;
    orderId: string;
    /** Smallest currency unit (paise for INR) -- exactly what Razorpay Checkout expects. */
    amount: number;
    currency: string;
    invoiceNumber: string;
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "You must be signed in to do that.",
  invoice_not_found: "That invoice could not be found.",
  permission_denied: "You don't have permission to make a payment for this company.",
  invoice_not_payable: "This invoice has already been paid, voided, or refunded.",
  invoice_amount_invalid: "This invoice has no payable amount.",
};

function friendlyError(message: string): string {
  return ERROR_MESSAGES[message] ?? "Could not start the payment. Please try again.";
}

export async function createPaymentOrderAction(
  invoiceId: string,
): Promise<CreatePaymentOrderResult> {
  const session = await getDashboardSession();
  if (!session) return { success: false, error: "You must be signed in to do that." };

  const env = loadEnv(process.env);
  if (!env.razorpayConfigured) {
    return {
      success: false,
      error: "Online payment is not configured yet. Please contact support.",
    };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .rpc("create_payment_order", { p_invoice_id: invoiceId })
    .single();
  if (error) return { success: false, error: friendlyError(error.message) };

  const row = data as {
    payment_id: string;
    amount: number;
    currency: string;
    invoice_number: string;
  };

  let order;
  try {
    order = await createRazorpayOrder(
      {
        amountInSmallestUnit: toSmallestCurrencyUnit(row.amount),
        currency: row.currency,
        receipt: row.payment_id,
      },
      env.RAZORPAY_KEY_ID!,
      env.RAZORPAY_KEY_SECRET!,
    );
  } catch {
    return { success: false, error: "Could not start the payment. Please try again." };
  }

  const { error: attachError } = await supabase.rpc("attach_razorpay_order", {
    p_payment_id: row.payment_id,
    p_razorpay_order_id: order.id,
  });
  if (attachError) return { success: false, error: friendlyError(attachError.message) };

  return {
    success: true,
    checkout: {
      keyId: env.RAZORPAY_KEY_ID!,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      invoiceNumber: row.invoice_number,
    },
  };
}

export interface VerifyPaymentCallbackResult {
  verified: boolean;
}

/**
 * Checks the Checkout success callback's signature only -- never mutates
 * any table. A true result means "Razorpay really did sign this
 * completion", not "the payment has been recorded" -- the invoice/
 * subscription only actually update once the webhook (apps/api,
 * reconcile_razorpay_payment) processes the same event, which this action
 * does not wait for. revalidatePath so the next load of /dashboard/billing
 * picks up the webhook's result once it lands (typically within a second
 * or two in practice).
 */
export async function verifyPaymentCallbackAction(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string,
): Promise<VerifyPaymentCallbackResult> {
  const session = await getDashboardSession();
  if (!session) return { verified: false };

  const env = loadEnv(process.env);
  if (!env.razorpayConfigured) return { verified: false };

  const verified = await verifyRazorpayPaymentSignature(
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    env.RAZORPAY_KEY_SECRET!,
  );

  revalidatePath("/dashboard/billing");
  return { verified };
}
