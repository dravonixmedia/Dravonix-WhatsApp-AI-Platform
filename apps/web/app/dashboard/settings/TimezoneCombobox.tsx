"use client";

import { useId, useMemo, useState, useTransition, type KeyboardEvent } from "react";
import { updateCompanyTimezoneAction } from "../../../lib/actions/timezone.js";

/**
 * Accessible searchable timezone combobox (ARIA combobox + listbox
 * pattern). Two confirmed, non-speculative fixes over the prior build:
 *
 * 1. "Failed to fetch" on save: the prior version received the Server
 *    Action via an `onSave` prop passed down from the Server Component
 *    (page.tsx) instead of importing it directly inside this "use client"
 *    file. Every other working client mutation in this codebase (see
 *    ReplyComposer.tsx, ReconcileAiMessageForm.tsx) imports its Server
 *    Action directly in the client file and calls it inside
 *    startTransition -- none of them receive it as a prop. This component
 *    now matches that exact, already-proven-on-staging pattern.
 * 2. Combobox opened showing only the current value: the prior version
 *    used one `query` state both as the input's displayed text AND as the
 *    filter string, pre-filled with the saved value. On open, before the
 *    user typed anything, the filter narrowed to substring matches of the
 *    current value -- which is only ever itself. `selectedValue` (the
 *    committed value) and `searchQuery` (the filter, starts empty) are now
 *    tracked separately: the full list shows on open, filtering only
 *    starts once the user actually types.
 *
 * The `options` list is supplied by the server (lib/timezoneList.ts) --
 * this component only filters/selects among values it was given (plus the
 * guaranteed-present initialValue), and only ever saves a string taken
 * verbatim from that combined list, never arbitrary typed text.
 */
export function TimezoneCombobox({
  label,
  helpText,
  initialValue,
  options,
  saveLabel = "Save Timezone",
}: {
  label: string;
  helpText: string;
  initialValue: string;
  options: readonly string[];
  saveLabel?: string;
}) {
  const inputId = useId();
  const listboxId = useId();
  const [selectedValue, setSelectedValue] = useState(initialValue);
  const [searchQuery, setSearchQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const allOptions = useMemo(() => {
    if (!initialValue || options.includes(initialValue)) return options;
    return [initialValue, ...options];
  }, [options, initialValue]);

  // Empty searchQuery means "not actively searching" -- show the full list
  // (still capped for render performance), not a filter of the selected value.
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matches =
      q.length === 0 ? allOptions : allOptions.filter((tz) => tz.toLowerCase().includes(q));
    return matches.slice(0, 50);
  }, [allOptions, searchQuery]);

  const displayValue = searchQuery.length > 0 ? searchQuery : selectedValue;
  const effectiveValue = displayValue.trim();
  const isValidSelection = allOptions.includes(effectiveValue);

  function selectOption(value: string) {
    setSelectedValue(value);
    setSearchQuery("");
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
      setSearchQuery("");
    }
  }

  function handleSave() {
    if (!isValidSelection) return;
    const value = effectiveValue;
    setStatus("saving");
    startTransition(async () => {
      try {
        await updateCompanyTimezoneAction(value);
        setSelectedValue(value);
        setSearchQuery("");
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
            value={displayValue}
            onChange={(event) => {
              setSearchQuery(event.target.value);
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
