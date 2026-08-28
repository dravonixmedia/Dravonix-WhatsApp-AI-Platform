"use client";

import type { ConversationThreadMessage } from "@dravonix/handover";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState, useTransition } from "react";
import {
  loadOlderMessagesAction,
  reconcileOutboundMessageAction,
} from "../../../../lib/actions/handover.js";
import { useTenantRealtimeChannel } from "../../../../lib/realtime/useTenantRealtimeChannel.js";
import { MESSAGE_THREAD_WATCHES } from "../../../../lib/realtime/watchConfigs.js";
import { OutboundStatusBadge } from "../../badges.js";
import { MicIcon } from "../../Icons.js";
import { resolveMessageBodyDisplay } from "./messageBodyDisplay.js";
import { ReconcileAiMessageForm } from "./ReconcileAiMessageForm.js";
import { mapRealtimeMessageRow, toRealtimeUpdatePatch } from "./realtimeMessageMapper.js";
import { bottomScrollTop, isNearBottom, scrollTopAfterPrepend } from "./scrollBehavior.js";
import { VoiceMessagePlayer } from "./VoiceMessagePlayer.js";
import {
  appendRealtimeMessage,
  applyRealtimeMessagePatch,
  initialThreadState,
  oldestCursor,
  prependOlderPage,
  type ThreadPageState,
} from "./threadPagination.js";

/**
 * What the pending scroll-position effect below should do the next time
 * `state.messages` changes -- set synchronously, in the same event handler
 * that triggers the state update, from measurements taken from the DOM
 * *before* that update (Phase 3B: latest-message opening & scroll
 * behavior). A discriminated union rather than a single boolean because
 * "prepend" needs to carry the pre-prepend scrollHeight forward to the
 * effect, and "prepend" must never be confused with "stick to bottom" --
 * conflating them was the bug in an earlier draft of this fix, where a
 * length-keyed effect would also fire (and wrongly re-stick to the bottom)
 * after "Load older messages" prepended a page.
 */
type PendingScroll =
  | { type: "none" }
  | { type: "stick-to-bottom" }
  | { type: "preserve-anchor"; scrollHeightBefore: number };

function ActionButton({ children }: { children: React.ReactNode }) {
  return (
    <button className="dvx-button" type="submit" style={{ fontSize: "0.8rem" }}>
      {children}
    </button>
  );
}

interface ConversationThreadProps {
  conversationId: string;
  initialMessages: ConversationThreadMessage[];
  initialHasMore: boolean;
  /** Realtime handshake -- see useTenantRealtimeChannel.ts. */
  accessToken: string;
}

/**
 * The scrollable message list plus its "Load older messages" control (final
 * plan section 16, extended for the dashboard-thread-pagination correction;
 * Phase 3B added the latest-message-on-open/switch scroll behavior below).
 * Keyed by conversationId at its call site in page.tsx, so opening a
 * different conversation -- or switching companies, since conversationId is
 * a globally-unique id no two companies ever share -- always remounts this
 * component from scratch: no locally accumulated older-page state, and no
 * stale scroll position, can ever survive a switch.
 */
export function ConversationThread({
  conversationId,
  initialMessages,
  initialHasMore,
  accessToken,
}: ConversationThreadProps) {
  const [state, setState] = useState<ThreadPageState>(() =>
    initialThreadState(initialMessages, initialHasMore),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // Defaults to "stick-to-bottom" so the very first layout effect run (right
  // after this fresh mount, since the component is remounted per
  // conversationId) lands the reader on the latest message -- see the
  // effect below.
  const pendingScrollRef = useRef<PendingScroll>({ type: "stick-to-bottom" });

  const { status: realtimeStatus } = useTenantRealtimeChannel({
    namespace: "conversation-thread",
    scopeId: conversationId,
    accessToken,
    watches: MESSAGE_THREAD_WATCHES,
    onChange: (_table, payload) => {
      if (payload.eventType === "INSERT") {
        // Measured *before* the state update below, from the DOM as it
        // exists right now -- i.e. "was the reader at the bottom just
        // before this message arrived". Covers the current user's own
        // just-sent reply too, with no special case: sending a reply is
        // itself only possible while reading at/near the live edge of the
        // conversation, so the same near-bottom check already follows it.
        const container = scrollContainerRef.current;
        pendingScrollRef.current = {
          type:
            !container ||
            isNearBottom({
              scrollTop: container.scrollTop,
              scrollHeight: container.scrollHeight,
              clientHeight: container.clientHeight,
            })
              ? "stick-to-bottom"
              : "none",
        };
        setState((prev) => appendRealtimeMessage(prev, mapRealtimeMessageRow(payload.new)));
      } else if (payload.eventType === "UPDATE") {
        const id = (payload.new as { id?: string }).id;
        if (id) {
          setState((prev) =>
            applyRealtimeMessagePatch(prev, id, toRealtimeUpdatePatch(payload.new)),
          );
        }
      }
    },
    onStaleReconnect: () => {
      // The channel was dropped and just came back -- any events that
      // occurred while disconnected were missed, so get an authoritative
      // reload from the server loader rather than trying to reconcile an
      // unknown gap of incremental patches.
      router.refresh();
    },
  });

  // Runs synchronously after the DOM reflects the current state.messages,
  // but before the browser paints -- applying the scroll position here
  // (rather than in a plain useEffect) is what keeps the reader from ever
  // seeing a visible top-then-jump-to-bottom flash on initial open. Keyed
  // on message *count* specifically: a realtime UPDATE (outbound_status
  // patch) never changes the count, so it correctly never re-triggers this,
  // and both "stick to bottom" (initial mount, realtime append) and
  // "preserve anchor" (Load older) are exactly the two ways the count can
  // change.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const pending = pendingScrollRef.current;
    if (!container || pending.type === "none") return;

    if (pending.type === "stick-to-bottom") {
      container.scrollTop = bottomScrollTop(container.scrollHeight, container.clientHeight);
    } else {
      container.scrollTop = scrollTopAfterPrepend(
        container.scrollTop,
        pending.scrollHeightBefore,
        container.scrollHeight,
      );
    }
    pendingScrollRef.current = { type: "none" };
  }, [state.messages.length]);

  function loadOlder() {
    const before = oldestCursor(state);
    if (!before) return;
    setLoadError(null);

    const container = scrollContainerRef.current;
    pendingScrollRef.current = {
      type: "preserve-anchor",
      scrollHeightBefore: container?.scrollHeight ?? 0,
    };

    startTransition(async () => {
      try {
        const olderPage = await loadOlderMessagesAction(conversationId, before);
        setState((prev) => prependOlderPage(prev, olderPage));
      } catch {
        pendingScrollRef.current = { type: "none" };
        setLoadError("Could not load older messages. Please try again.");
      }
    });
  }

  return (
    <div
      ref={scrollContainerRef}
      style={{
        flex: 1,
        minHeight: 0,
        padding: "1rem 1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.6rem",
        overflowY: "auto",
      }}
    >
      {realtimeStatus === "reconnecting" ? (
        <span
          className="dvx-badge dvx-badge--warning"
          style={{ alignSelf: "center" }}
          role="status"
        >
          Reconnecting…
        </span>
      ) : null}

      {state.hasMore ? (
        <button
          type="button"
          className="dvx-button"
          style={{ fontSize: "0.75rem", alignSelf: "center" }}
          onClick={loadOlder}
          disabled={isPending}
        >
          {isPending ? "Loading..." : "Load older messages"}
        </button>
      ) : state.messages.length > 0 ? (
        <p className="dvx-muted" style={{ fontSize: "0.75rem", textAlign: "center", margin: 0 }}>
          Beginning of conversation
        </p>
      ) : null}

      {loadError ? (
        <p style={{ color: "#dc2626", fontSize: "0.8rem", textAlign: "center", margin: 0 }}>
          {loadError}
        </p>
      ) : null}

      {state.messages.length === 0 ? (
        <p className="dvx-muted" style={{ textAlign: "center" }}>
          No messages yet.
        </p>
      ) : (
        state.messages.map((message) => {
          const isCustomer = message.senderType === "customer";
          const needsReconcile =
            message.outboundStatus === "delivery_unknown" ||
            message.outboundStatus === "send_failed";
          const bubbleClass =
            message.senderType === "customer" || message.senderType === "system"
              ? message.senderType === "system"
                ? "dvx-msg-bubble dvx-msg-bubble--system"
                : "dvx-msg-bubble dvx-msg-bubble--inbound"
              : message.senderType === "ai"
                ? "dvx-msg-bubble dvx-msg-bubble--outbound-ai"
                : "dvx-msg-bubble dvx-msg-bubble--outbound-human";
          return (
            <div
              key={message.id}
              className={`dvx-msg-row ${isCustomer ? "dvx-msg-row--inbound" : "dvx-msg-row--outbound"}`}
            >
              <div className="dvx-msg-meta">
                <span style={{ textTransform: "capitalize" }}>
                  {message.senderType === "human_agent" ? "Agent" : message.senderType}
                </span>
                {message.channelType === "audio" ? <MicIcon size={11} /> : null}
                <span>
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <OutboundStatusBadge status={message.outboundStatus} />
              </div>
              <div className={bubbleClass}>
                {resolveMessageBodyDisplay(message)}
                {message.mediaFileId ? (
                  <VoiceMessagePlayer
                    mediaFileId={message.mediaFileId}
                    durationSeconds={message.mediaDurationSeconds}
                  />
                ) : null}
              </div>
              {needsReconcile ? (
                <div style={{ marginTop: "0.4rem" }}>
                  <p style={{ color: "var(--warning)", fontSize: "0.75rem", margin: "0 0 0.3rem" }}>
                    {message.outboundStatus === "delivery_unknown"
                      ? "Delivery could not be confirmed -- manual reconciliation required."
                      : "This send failed."}
                  </p>
                  {message.senderType === "ai" ? (
                    <ReconcileAiMessageForm
                      messageId={message.id}
                      conversationId={conversationId}
                    />
                  ) : (
                    <div style={{ display: "flex", gap: "0.3rem" }}>
                      <form
                        action={async () => {
                          await reconcileOutboundMessageAction(
                            message.id,
                            conversationId,
                            "confirm_sent",
                          );
                        }}
                      >
                        <ActionButton>Confirm sent</ActionButton>
                      </form>
                      <form
                        action={async () => {
                          await reconcileOutboundMessageAction(
                            message.id,
                            conversationId,
                            "confirm_not_sent",
                          );
                        }}
                      >
                        <ActionButton>Confirm not sent</ActionButton>
                      </form>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
