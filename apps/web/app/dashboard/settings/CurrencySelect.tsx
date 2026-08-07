"use client";

import { useState, useTransition } from "react";
import type { SupportedCurrency } from "../../../lib/currencyList.js";

/**
 * Business Currency dropdown. A plain native <select> is intentional here
 * (unlike the timezone field) -- the supported-currency list is a dozen
 * entries, not hundreds, so a searchable combobox would be unnecessary
 * complexity; a native <select> is already fully keyboard- and
 * screen-reader-accessible. Entirely independent of TimezoneCombobox: no
 * shared state, no timezone->currency or currency->timezone lookup.
 */
export function CurrencySelect({
  label,
  helpText,
  initialValue,
  currencies,
  onSave,
  saveLabel = "Save Currency",
}: {
  label: string;
  helpText: string;
  initialValue: string;
  currencies: readonly SupportedCurrency[];
  onSave: (currency: string) => Promise<void>;
  saveLabel?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setStatus("saving");
    startTransition(async () => {
      try {
        await onSave(value);
        setStatus("success");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to save currency");
        setStatus("error");
      }
    });
  }

  const statusText =
    status === "saving"
      ? "Saving..."
      : status === "success"
        ? "Saved"
        : status === "error"
          ? errorMessage || "Unable to save currency"
          : "";

  return (
    <div style={{ padding: "0.6rem 0", borderTop: "1px solid var(--border-default)" }}>
      <label
        htmlFor="business-currency"
        style={{ fontSize: "0.8rem", fontWeight: 600, display: "block" }}
      >
        {label}
      </label>
      <p className="dvx-muted" style={{ fontSize: "0.75rem", margin: "0.15rem 0 0.5rem" }}>
        {helpText}
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <select
          id="business-currency"
          className="dvx-input"
          style={{ flex: "1 1 200px", minWidth: 0 }}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setStatus("idle");
          }}
        >
          {currencies.map((currency) => (
            <option key={currency.code} value={currency.code}>
              {currency.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="dvx-button dvx-button--secondary"
          disabled={isPending}
          onClick={handleSave}
        >
          {saveLabel}
        </button>
      </div>
      <p
        aria-live="polite"
        style={{
          fontSize: "0.75rem",
          margin: "0.4rem 0 0",
          minHeight: "1em",
          color: status === "error" ? "var(--danger)" : "var(--text-muted)",
        }}
      >
        {statusText}
      </p>
    </div>
  );
}
