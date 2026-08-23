"use client";

import { useState, useTransition } from "react";
import type { UpdateDisplayNameResult } from "../lib/actions/memberIdentity.js";

/**
 * Inline "Edit name" control shared by the Super Admin Users & Roles card
 * and the client Team page. Each call site binds its own Server Action
 * (self-edit / team.manage vs. Super Admin) via .bind(null, ...) before
 * passing it in as `onSave` -- this component carries no authorization
 * logic of its own, only the toggle/input/save-cancel UI and the
 * success-or-failure feedback, following the same useTransition pattern as
 * InvitationActions.tsx.
 */
export function EditDisplayNameControl({
  currentDisplayName,
  onSave,
}: {
  currentDisplayName: string | null;
  onSave: (formData: FormData) => Promise<UpdateDisplayNameResult>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(currentDisplayName ?? "");
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(
    null,
  );

  function handleSave() {
    setFeedback(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("display_name", value);
      const result = await onSave(formData);
      if (result.success) {
        setFeedback({ kind: "success", text: "Name updated." });
        setIsEditing(false);
      } else {
        setFeedback({ kind: "error", text: result.error ?? "Could not update the name." });
      }
    });
  }

  if (!isEditing) {
    return (
      <div
        style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.3rem" }}
      >
        <button
          className="dvx-button dvx-button--secondary"
          type="button"
          onClick={() => {
            setValue(currentDisplayName ?? "");
            setFeedback(null);
            setIsEditing(true);
          }}
          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
        >
          Edit name
        </button>
        {feedback ? (
          <span
            style={{
              fontSize: "0.75rem",
              color: feedback.kind === "error" ? "#dc2626" : undefined,
            }}
          >
            {feedback.text}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.3rem" }}
    >
      <div style={{ display: "flex", gap: "0.3rem" }}>
        <input
          className="dvx-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={isPending}
          autoFocus
          maxLength={150}
          style={{ fontSize: "0.78rem", padding: "0.3rem 0.5rem", width: 160 }}
        />
        <button
          className="dvx-button dvx-button--secondary"
          type="button"
          disabled={isPending}
          onClick={handleSave}
          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
        >
          {isPending ? "Saving..." : "Save"}
        </button>
        <button
          className="dvx-button dvx-button--secondary"
          type="button"
          disabled={isPending}
          onClick={() => {
            setIsEditing(false);
            setFeedback(null);
          }}
          style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
        >
          Cancel
        </button>
      </div>
      {feedback ? (
        <span
          style={{ fontSize: "0.75rem", color: feedback.kind === "error" ? "#dc2626" : undefined }}
        >
          {feedback.text}
        </span>
      ) : null}
    </div>
  );
}
