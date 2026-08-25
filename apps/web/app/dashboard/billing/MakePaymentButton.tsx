"use client";

import { useState } from "react";
import {
  createPaymentOrderAction,
  verifyPaymentCallbackAction,
} from "../../../lib/actions/billing.js";

interface RazorpayCheckoutInstance {
  open: () => void;
}

interface RazorpaySuccessResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckoutInstance;
  }
}

const CHECKOUT_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadRazorpayCheckoutScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_SRC;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

type PaymentUiStatus = "idle" | "starting" | "error" | "submitted";

/**
 * Client-side Checkout launcher. Every value it hands to Razorpay's widget
 * (keyId, orderId, amount, currency) comes back from
 * createPaymentOrderAction, which itself only ever returns what the server
 * already verified against the invoice row -- this component never
 * constructs or edits any of those values itself. The success handler only
 * verifies the callback signature (for UI feedback); it never marks
 * anything paid -- that happens exclusively via the Razorpay webhook.
 */
export function MakePaymentButton({ invoiceId }: { invoiceId: string }) {
  const [status, setStatus] = useState<PaymentUiStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handlePay() {
    setStatus("starting");
    setErrorMessage(null);

    const result = await createPaymentOrderAction(invoiceId);
    if (!result.success || !result.checkout) {
      setStatus("error");
      setErrorMessage(result.error ?? "Could not start the payment.");
      return;
    }

    const scriptLoaded = await loadRazorpayCheckoutScript();
    if (!scriptLoaded || !window.Razorpay) {
      setStatus("error");
      setErrorMessage("Could not load the payment window. Please try again.");
      return;
    }

    const { checkout } = result;
    const razorpay = new window.Razorpay({
      key: checkout.keyId,
      order_id: checkout.orderId,
      amount: checkout.amount,
      currency: checkout.currency,
      name: "Dravonix Media",
      description: `Invoice ${checkout.invoiceNumber}`,
      handler: (response: RazorpaySuccessResponse) => {
        void verifyPaymentCallbackAction(
          response.razorpay_order_id,
          response.razorpay_payment_id,
          response.razorpay_signature,
        );
        setStatus("submitted");
      },
      modal: {
        ondismiss: () => setStatus("idle"),
      },
    });
    razorpay.open();
    setStatus("idle");
  }

  if (status === "submitted") {
    return (
      <span className="dvx-muted" style={{ fontSize: "0.78rem" }}>
        Payment submitted — confirming...
      </span>
    );
  }

  return (
    <div>
      <button
        className="dvx-button"
        type="button"
        onClick={() => void handlePay()}
        disabled={status === "starting"}
        style={{ fontSize: "0.78rem" }}
      >
        {status === "starting" ? "Starting..." : "Pay Now"}
      </button>
      {errorMessage ? (
        <p className="dvx-muted" style={{ fontSize: "0.72rem", marginTop: "0.3rem" }}>
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
