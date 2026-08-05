"use client";

import { useEffect } from "react";

/**
 * Next.js route-segment error boundary for /dashboard/* -- must be a Client
 * Component (framework requirement). `error.message` is never rendered:
 * Next.js already strips server error details in production builds before
 * this component ever sees them, and this stays true defense-in-depth even
 * in development. Only `error.digest` (a safe, non-sensitive correlation
 * id) is shown, so a report can be matched to server logs without exposing
 * internals.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Client-side-only: no server log write here, just keeps the error
    // visible in the browser console for local debugging.
    console.error(error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div className="dvx-card" style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>Something went wrong</h1>
        <p className="dvx-muted" style={{ margin: "0 0 1rem", fontSize: "0.9rem" }}>
          This page couldn&apos;t load. Try again, or go back to the Overview.
        </p>
        {error.digest ? (
          <p className="dvx-muted" style={{ fontSize: "0.72rem", margin: "0 0 1rem" }}>
            Reference: {error.digest}
          </p>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
          <button className="dvx-button" type="button" onClick={reset}>
            Try again
          </button>
          <a
            href="/dashboard"
            className="dvx-button dvx-button--secondary"
            style={{ textDecoration: "none" }}
          >
            Go to Overview
          </a>
        </div>
      </div>
    </div>
  );
}
