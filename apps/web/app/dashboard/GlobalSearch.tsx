"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { globalSearchAction } from "../../lib/actions/globalSearch.js";
import {
  GLOBAL_SEARCH_MIN_LENGTH,
  type GlobalSearchResults,
} from "../../lib/repositories/globalSearchRepository.js";
import { SearchIcon } from "./Icons.js";

const DEBOUNCE_MS = 300;

type FlatResult =
  | { kind: "conversation"; id: string; href: string; primary: string; secondary: string | null }
  | { kind: "lead"; id: string; href: string; primary: string; secondary: string | null };

function flattenResults(results: GlobalSearchResults): FlatResult[] {
  return [
    ...results.conversations.map((c): FlatResult => ({
      kind: "conversation",
      id: c.conversationId,
      href: `/dashboard/conversations/${c.conversationId}`,
      primary: c.displayName,
      secondary: c.latestMessagePreview ?? c.maskedPhoneNumber,
    })),
    ...results.leads.map((l): FlatResult => ({
      kind: "lead",
      id: l.leadId,
      href: `/dashboard/leads/${l.leadId}`,
      primary: l.displayName,
      secondary: l.serviceInterest ?? l.stage.replace(/_/g, " "),
    })),
  ];
}

/**
 * Real tenant-scoped global search across Live Conversations and Leads
 * (the two modules with real backend query support -- see
 * lib/actions/globalSearch.ts). Client-only for the debounce/keyboard-nav
 * interaction; the actual query always runs server-side via a Server Action
 * using the caller's own session-derived company, never a value this
 * component could supply.
 */
export function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResults | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const requestIdRef = useRef(0);

  const flat = useMemo(() => (results ? flattenResults(results) : []), [results]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < GLOBAL_SEARCH_MIN_LENGTH) {
      setResults(null);
      setStatus("idle");
      setActiveIndex(-1);
      return;
    }
    setStatus("loading");
    const requestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(() => {
      globalSearchAction(trimmed)
        .then((data) => {
          if (requestIdRef.current !== requestId) return; // a newer keystroke superseded this request
          setResults(data);
          setStatus("idle");
          setActiveIndex(-1);
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return;
          setStatus("error");
          setResults(null);
        });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function navigateTo(item: FlatResult) {
    setOpen(false);
    setQuery("");
    setResults(null);
    router.push(item.href);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (!open || flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < flat.length) {
        e.preventDefault();
        navigateTo(flat[activeIndex]!);
      }
    }
  }

  const showDropdown = open && query.trim().length >= GLOBAL_SEARCH_MIN_LENGTH;

  return (
    <div ref={containerRef} className="dvx-topbar-search" style={{ position: "relative" }}>
      <SearchIcon />
      <input
        type="search"
        placeholder="Search conversations, leads..."
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        aria-label="Search conversations and leads"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls="dvx-global-search-results"
        aria-autocomplete="list"
      />
      {showDropdown ? (
        <div id="dvx-global-search-results" className="dvx-search-panel" role="listbox">
          {status === "loading" ? (
            <div className="dvx-search-status">Searching…</div>
          ) : status === "error" ? (
            <div className="dvx-search-status dvx-search-status--error">
              Search failed. Try again.
            </div>
          ) : flat.length === 0 ? (
            <div className="dvx-search-status">No results for &ldquo;{query.trim()}&rdquo;.</div>
          ) : (
            <>
              {results && results.conversations.length > 0 ? (
                <div className="dvx-search-group">
                  <div className="dvx-search-group-label">Conversations</div>
                  {results.conversations.map((c) => {
                    const index = flat.findIndex(
                      (f) => f.kind === "conversation" && f.id === c.conversationId,
                    );
                    return (
                      <button
                        key={c.conversationId}
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        className={`dvx-search-result${index === activeIndex ? " dvx-search-result--active" : ""}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => navigateTo(flat[index]!)}
                      >
                        <span style={{ fontWeight: 600 }}>{c.displayName}</span>
                        <span className="dvx-muted" style={{ fontSize: "0.78rem" }}>
                          {c.latestMessagePreview ?? c.maskedPhoneNumber}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {results && results.leads.length > 0 ? (
                <div className="dvx-search-group">
                  <div className="dvx-search-group-label">Leads</div>
                  {results.leads.map((l) => {
                    const index = flat.findIndex((f) => f.kind === "lead" && f.id === l.leadId);
                    return (
                      <button
                        key={l.leadId}
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        className={`dvx-search-result${index === activeIndex ? " dvx-search-result--active" : ""}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => navigateTo(flat[index]!)}
                      >
                        <span style={{ fontWeight: 600 }}>{l.displayName}</span>
                        <span className="dvx-muted" style={{ fontSize: "0.78rem" }}>
                          {l.serviceInterest ?? l.stage.replace(/_/g, " ")}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
