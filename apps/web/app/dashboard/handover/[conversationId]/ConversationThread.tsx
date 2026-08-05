"use client";

import type { ConversationThreadMessage } from "@dravonix/handover";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  loadOlderMessagesAction,
  reconcileOutboundMessageAction,
} from "../../../../lib/actions/handover.js";
import { useTenantRealtimeChannel } from "../../../../lib/realtime/useTenantRealtimeChannel.js";
import { MESSAGE_THREAD_WATCHES } from "../../../../lib/realtime/watchConfigs.js";
import { resolveMessageBodyDisplay } from "./messageBodyDisplay.js";
import { ReconcileAiMessageForm } from "./ReconcileAiMessageForm.js";
import { mapRealtimeMessageRow } from "./realtimeMessageMapper.js";
import {
  appendRealtimeMessage,
  applyRealtimeMessagePatch,
  initialThreadState,
  oldestCursor,
  prependOlderPage,
  type ThreadPageState,
} from "./threadPagination.js";

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
 * plan section 16, extended for the dashboard-thread-pagination correction).
 * Keyed by companyId at its call site in page.tsx, so switching the active
 * company always remounts this component from scratch -- no locally
 * accumulated older-page state can ever survive a company switch.
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

  useTenantRealtimeChannel({
    namespace: "conversation-thread",
    scopeId: conversationId,
    accessToken,
    watches: MESSAGE_THREAD_WATCHES,
    onChange: (_table, payload) => {
      if (payload.eventType === "INSERT") {
        setState((prev) => appendRealtimeMessage(prev, mapRealtimeMessageRow(payload.new)));
      } else if (payload.eventType === "UPDATE") {
        const id = (payload.new as { id?: string }).id;
        if (id) {
          setState((prev) =>
            applyRealtimeMessagePatch(prev, id, mapRealtimeMessageRow(payload.new)),
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

  function loadOlder() {
    const before = oldestCursor(state);
    if (!before) return;
    setLoadError(null);

    const container = scrollContainerRef.current;
    const previousScrollHeight = container?.scrollHeight ?? 0;

    startTransition(async () => {
      try {
        const olderPage = await loadOlderMessagesAction(conversationId, before);
        setState((prev) => prependOlderPage(prev, olderPage));
        // Preserve scroll position: prepending grows the container from the
        // top, which would otherwise visually jump the reader down to the
        // newly-added messages -- restoring scrollTop by exactly the added
        // height keeps whatever was on screen in the same place.
        requestAnimationFrame(() => {
          if (container) {
            container.scrollTop += container.scrollHeight - previousScrollHeight;
          }
        });
      } catch {
        setLoadError("Could not load older messages. Please try again.");
      }
    });
  }

  return (
    <div
      ref={scrollContainerRef}
      style={{
        marginTop: "1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.6rem",
        maxHeight: "55vh",
        overflowY: "auto",
      }}
    >
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
          return (
            <div
              key={message.id}
              className="dvx-card"
              style={{
                alignSelf: isCustomer ? "flex-start" : "flex-end",
                maxWidth: "70%",
              }}
            >
              <div className="dvx-muted" style={{ fontSize: "0.7rem", marginBottom: "0.25rem" }}>
                {message.senderType} · {message.channelType} ·{" "}
                {new Date(message.createdAt).toLocaleString()}
                {message.outboundStatus ? ` · ${message.outboundStatus}` : ""}
              </div>
              <div>{resolveMessageBodyDisplay(message)}</div>
              {needsReconcile ? (
                <div style={{ marginTop: "0.4rem" }}>
                  <p style={{ color: "#b45309", fontSize: "0.75rem", margin: "0 0 0.3rem" }}>
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
