"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

interface DraivaDraftContextValue {
  draft: string;
  setDraft: (value: string) => void;
}

const DraivaDraftContext = createContext<DraivaDraftContextValue | null>(null);

/**
 * Shares one reply draft between the center column's ReplyComposer and the
 * right column's ChatAgentPanel ("Use in reply" fills the same draft the
 * composer sends) even though they render in two different branches of the
 * three-column layout -- a plain lifted-state wrapper would need to be
 * their common parent in the JSX tree, which the column layout doesn't
 * allow, so this uses context instead.
 *
 * The call site in page.tsx mounts this with `key={conversationId}`
 * (mirroring ConversationThread's own remount-per-conversation fix from
 * Phase 3B), so switching conversations always starts from an empty draft
 * rather than leaking one conversation's unsent text into another's
 * composer.
 */
export function DraivaDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState("");
  return (
    <DraivaDraftContext.Provider value={{ draft, setDraft }}>
      {children}
    </DraivaDraftContext.Provider>
  );
}

export function useDraivaDraft(): DraivaDraftContextValue {
  const ctx = useContext(DraivaDraftContext);
  if (!ctx) {
    throw new Error("useDraivaDraft must be used within a DraivaDraftProvider");
  }
  return ctx;
}
