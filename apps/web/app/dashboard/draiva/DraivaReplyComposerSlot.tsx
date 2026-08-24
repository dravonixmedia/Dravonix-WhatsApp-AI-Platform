"use client";

import { ReplyComposer } from "../handover/[conversationId]/ReplyComposer.js";
import { useDraivaDraft } from "./DraivaDraftContext.js";

/**
 * The center column's manual-reply composer for the DRAIVA workspace --
 * ReplyComposer itself is unchanged (Section 11: "do not build a second
 * composer"), only made controlled via the shared draft context so DRAIVA's
 * "Use in reply" (right column) can fill it.
 */
export function DraivaReplyComposerSlot({ conversationId }: { conversationId: string }) {
  const { draft, setDraft } = useDraivaDraft();
  return <ReplyComposer conversationId={conversationId} value={draft} onChange={setDraft} />;
}
