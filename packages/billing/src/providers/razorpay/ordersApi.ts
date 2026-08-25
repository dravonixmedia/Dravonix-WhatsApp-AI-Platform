/**
 * Minimal Razorpay Orders API client using the platform fetch primitive
 * directly (no `razorpay` npm SDK dependency -- the Orders API is one POST
 * request with HTTP Basic Auth, and the smallest auditable surface here is
 * no dependency at all, matching this repo's existing preference for
 * hand-rolled HTTPS calls over provider SDKs, e.g. ZeptoMailEmailProvider).
 * Order creation always happens server-side (this module is never imported
 * by client-rendered code): the amount/currency it's called with must
 * already be server-verified (create_payment_order RPC), never a value
 * read from the browser.
 */

const RAZORPAY_ORDERS_ENDPOINT = "https://api.razorpay.com/v1/orders";

export interface CreateRazorpayOrderInput {
  /** Smallest currency unit (paise for INR) -- the caller converts from a decimal amount before calling this. */
  amountInSmallestUnit: number;
  currency: string;
  /** Opaque internal reference (e.g. the payments.id row this order belongs to) -- never a customer name/phone/email. */
  receipt: string;
  /** Safe, non-sensitive key/value pairs only -- never secrets or customer PII. */
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
}

export class RazorpayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RazorpayApiError";
  }
}

/**
 * Creates a Razorpay Order. `keyId`/`keySecret` are the RAZORPAY_KEY_ID/
 * RAZORPAY_KEY_SECRET values -- keySecret must come from server-only
 * config and must never be logged (this function never logs its inputs).
 */
export async function createRazorpayOrder(
  input: CreateRazorpayOrderInput,
  keyId: string,
  keySecret: string,
): Promise<RazorpayOrder> {
  const basicAuth = btoa(`${keyId}:${keySecret}`);
  const response = await fetch(RAZORPAY_ORDERS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: input.amountInSmallestUnit,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {},
    }),
  });

  if (!response.ok) {
    // Never include response body verbatim -- Razorpay error payloads can
    // echo back request fields; keep the thrown error to status + a fixed
    // message so nothing sensitive can end up in a log via this path.
    throw new RazorpayApiError(
      `Razorpay order creation failed with status ${response.status}`,
      response.status,
    );
  }

  const body = (await response.json()) as RazorpayOrder;
  return body;
}
