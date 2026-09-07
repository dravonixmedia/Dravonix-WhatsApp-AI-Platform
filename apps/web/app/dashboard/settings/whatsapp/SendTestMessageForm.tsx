"use client";

import { useState } from "react";
import { sendWhatsappTestMessageAction } from "../../../../lib/actions/whatsappTestMessage.js";

/**
 * Protected outgoing-test-message control: the phone number is fixed by
 * `phoneNumberRowId` (this company's own row, resolved server-side by the
 * action itself) -- the only thing the viewer chooses is the recipient and
 * message text. Never lets the browser choose which credential/company to
 * send from.
 */
export function SendTestMessageForm({ phoneNumberRowId }: { phoneNumberRowId: string }) {
  const [toWaId, setToWaId] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    setError(null);
    try {
      const result = await sendWhatsappTestMessageAction(phoneNumberRowId, toWaId, body);
      if (!result.success) {
        setStatus("idle");
        setError(result.error ?? "Unable to send the test message.");
        return;
      }
      setStatus("sent");
      setBody("");
    } catch {
      setStatus("idle");
      setError("Unable to send the test message.");
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} style={{ marginTop: "0.5rem" }}>
      <input
        type="text"
        placeholder="Recipient (e.g. 919999999999)"
        value={toWaId}
        onChange={(event) => setToWaId(event.target.value)}
        required
        style={{ display: "block", width: "100%", marginBottom: "0.4rem" }}
      />
      <input
        type="text"
        placeholder="Test message text"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        required
        style={{ display: "block", width: "100%", marginBottom: "0.4rem" }}
      />
      <button
        type="submit"
        className="dvx-button dvx-button--secondary"
        disabled={status === "sending"}
        style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
      >
        {status === "sending" ? "Sending…" : "Send test message"}
      </button>
      {status === "sent" ? (
        <p className="dvx-muted" style={{ fontSize: "0.8rem" }}>
          Test message sent.
        </p>
      ) : null}
      {error ? <p style={{ color: "#b42318", fontSize: "0.8rem" }}>{error}</p> : null}
    </form>
  );
}
