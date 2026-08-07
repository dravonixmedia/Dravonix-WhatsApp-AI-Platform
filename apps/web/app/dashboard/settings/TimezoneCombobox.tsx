"use client";

import { useId, useMemo, useState, useTransition, type KeyboardEvent } from "react";

/**
 * Accessible searchable timezone combobox (ARIA combobox + listbox
 * pattern). Replaces the earlier <input list>+<datalist> approach for two
 * confirmed, non-speculative reasons:
 *
 * 1. Native <datalist> has no visible "more options exist" affordance --
 *    once the field is pre-filled with the saved value, it just looks like
 *    a plain text box with one value in it, with no indicator that
 *    hundreds of other options exist underneath.
 * 2. Intl.supportedValuesOf("timeZone") -- the previous option source --
 *    only returns ICU's "canonical" zone IDs and omits legacy-but-valid
 *    aliases. Verified directly: it does not include "Asia/Kolkata" (ICU
 *    canonicalizes to "Asia/Calcutta"), which is companies.timezone's own
 *    database default. A company whose saved timezone was still the
 *    default would find its own value absent from the option list --
 *    exactly the reported "selector only shows Asia/Kolkata, nothing else
 *    is selectable" symptom, not a UI-only issue. lib/timezoneList.ts now
 *    patches this specific, verified gap; this component additionally
 *    guarantees the current value is always present regardless (below),
 *    as defense in depth against any other company's saved value that
 *    happens to be some other legacy alias.
 *
 * The `options` list is supplied by the server (lib/timezoneList.ts) --
 * this component only filters/selects among values it was given (plus the
 * guaranteed-present initialValue), and only ever calls `onSave` with a
 * string taken verbatim from that combined list, never arbitrary typed
 * text.
 */
export function TimezoneCombobox({
  label,
  helpText,
  initialValue,
  options,
  onSave,
  saveLabel = "Save Timezone",
}: {
  label: string;
  helpText: string;
  initialValue: string;
  options: readonly string[];
  onSave: (timezone: string) => Promise<void>;
  saveLabel?: string;
}) {
  const inputId = useId();
  const listboxId = useId();
  const [query, setQuery] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const allOptions = useMemo(() => {
    if (!initialValue || options.includes(initialValue)) return options;
    return [initialValue, ...options];
  }, [options, initialValue]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches =
      q.length === 0 ? allOptions : allOptions.filter((tz) => tz.toLowerCase().includes(q));
    return matches.slice(0, 50);
  }, [allOptions, query]);

  const isValidSelection = allOptions.includes(query.trim());

  function selectOption(value: string) {
    setQuery(value);
    setOpen(false);
    setStatus("idle");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      if (open && filtered[activeIndex]) {
        event.preventDefault();
        selectOption(filtered[activeIndex]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  function handleSave() {
    if (!isValidSelection) return;
    const value = query.trim();
    setStatus("saving");
    startTransition(async () => {
      try {
        await onSave(value);
        setStatus("success");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to save timezone");
        setStatus("error");
      }
    });
  }

  const activeOptionId =
    open && filtered[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined;

  const statusText =
    status === "saving"
      ? "Saving..."
      : status === "success"
        ? "Saved"
        : status === "error"
          ? errorMessage || "Unable to save timezone"
          : "";

  return (
    <div style={{ padding: "0.6rem 0", borderTop: "1px solid var(--border-default)" }}>
      <label htmlFor={inputId} style={{ fontSize: "0.8rem", fontWeight: 600, display: "block" }}>
        {label}
      </label>
      <p className="dvx-muted" style={{ fontSize: "0.75rem", margin: "0.15rem 0 0.5rem" }}>
        {helpText}
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 200px", minWidth: 0 }}>
          <input
            id={inputId}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActiveIndex(0);
              setStatus("idle");
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            className="dvx-input"
            style={{ width: "100%" }}
            placeholder="Search timezone, e.g. Dubai, London, Kolkata"
          />
          {open ? (
            <ul
              id={listboxId}
              role="listbox"
              aria-label={label}
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                maxHeight: "16rem",
                overflowY: "auto",
                margin: 0,
                padding: "0.25rem",
                listStyle: "none",
                background: "var(--surface-primary)",
                border: "1px solid var(--border-strong)",
                borderRadius: "10px",
                boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
                zIndex: 20,
              }}
            >
              {filtered.length === 0 ? (
                <li className="dvx-muted" style={{ padding: "0.4rem 0.6rem", fontSize: "0.85rem" }}>
                  No matching timezone
                </li>
              ) : (
                filtered.map((tz, index) => (
                  <li
                    key={tz}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectOption(tz)}
                    onMouseEnter={() => setActiveIndex(index)}
                    style={{
                      padding: "0.4rem 0.6rem",
                      fontSize: "0.85rem",
                      borderRadius: "6px",
                      cursor: "pointer",
                      background: index === activeIndex ? "var(--surface-selected)" : "transparent",
                    }}
                  >
                    {tz}
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          className="dvx-button dvx-button--secondary"
          disabled={!isValidSelection || isPending}
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
