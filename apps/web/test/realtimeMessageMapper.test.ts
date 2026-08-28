import { describe, expect, it } from "vitest";
import {
  mapRealtimeMessageRow,
  toRealtimeUpdatePatch,
} from "../app/dashboard/handover/[conversationId]/realtimeMessageMapper.js";
import {
  applyRealtimeMessagePatch,
  initialThreadState,
} from "../app/dashboard/handover/[conversationId]/threadPagination.js";

describe("mapRealtimeMessageRow", () => {
  it("maps a full raw messages row (snake_case) into ConversationThreadMessage (camelCase)", () => {
    const row = {
      id: "m1",
      direction: "outbound",
      channel_type: "text",
      sender_type: "human_agent",
      sender_member_id: "member-1",
      body: "Hello",
      outbound_status: "sent",
      provider_message_id: "wamid.123",
      created_at: "2026-01-01T00:00:00.000Z",
      // Extra columns present on the real table row but not rendered by the
      // thread UI -- must be ignored, not cause a mapping error.
      company_id: "company-1",
      conversation_id: "conversation-1",
    };
    expect(mapRealtimeMessageRow(row)).toEqual({
      id: "m1",
      direction: "outbound",
      channelType: "text",
      senderType: "human_agent",
      senderMemberId: "member-1",
      body: "Hello",
      mediaFileId: null,
      mediaMimeType: null,
      mediaDurationSeconds: null,
      outboundStatus: "sent",
      providerMessageId: "wamid.123",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("defaults nullable columns to null when absent", () => {
    const row = {
      id: "m2",
      direction: "inbound",
      channel_type: "text",
      sender_type: "customer",
      body: "Hi",
      created_at: "2026-01-01T00:01:00.000Z",
    };
    const mapped = mapRealtimeMessageRow(row);
    expect(mapped.senderMemberId).toBeNull();
    expect(mapped.outboundStatus).toBeNull();
    expect(mapped.providerMessageId).toBeNull();
  });
});

describe("toRealtimeUpdatePatch", () => {
  const rawUpdateRow = {
    id: "m1",
    direction: "outbound",
    channel_type: "audio",
    sender_type: "human_agent",
    sender_member_id: "member-1",
    body: null,
    outbound_status: "sent",
    provider_message_id: "wamid.123",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("omits mediaFileId/mediaMimeType/mediaDurationSeconds entirely -- never sets them to null on the patch object", () => {
    const patch = toRealtimeUpdatePatch(rawUpdateRow);
    expect(patch).not.toHaveProperty("mediaFileId");
    expect(patch).not.toHaveProperty("mediaMimeType");
    expect(patch).not.toHaveProperty("mediaDurationSeconds");
  });

  it("still includes every other field mapRealtimeMessageRow produces", () => {
    const patch = toRealtimeUpdatePatch(rawUpdateRow);
    expect(patch).toEqual({
      id: "m1",
      direction: "outbound",
      channelType: "audio",
      senderType: "human_agent",
      senderMemberId: "member-1",
      body: null,
      outboundStatus: "sent",
      providerMessageId: "wamid.123",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("REGRESSION (P1 dashboard hygiene correction): applying the real production patch to an already-hydrated voice message preserves its media fields while still updating outboundStatus -- the exact bug found by independent review", () => {
    const hydratedMessage = {
      id: "m1",
      direction: "outbound" as const,
      channelType: "audio" as const,
      senderType: "human_agent" as const,
      senderMemberId: "member-1",
      body: null,
      outboundStatus: "sending" as const,
      providerMessageId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      mediaFileId: "media-123",
      mediaMimeType: "audio/ogg",
      mediaDurationSeconds: 12.5,
    };
    const state = initialThreadState([hydratedMessage], false);

    // The exact call sequence ConversationThread.tsx's UPDATE handler makes.
    const next = applyRealtimeMessagePatch(state, "m1", toRealtimeUpdatePatch(rawUpdateRow));

    const updated = next.messages.find((m) => m.id === "m1");
    expect(updated?.mediaFileId).toBe("media-123");
    expect(updated?.mediaMimeType).toBe("audio/ogg");
    expect(updated?.mediaDurationSeconds).toBe(12.5);
    // The realtime update itself still applies normally.
    expect(updated?.outboundStatus).toBe("sent");
    expect(updated?.providerMessageId).toBe("wamid.123");
  });

  it("a text message's UPDATE still applies normally (no media fields involved either way)", () => {
    const hydratedTextMessage = {
      id: "m2",
      direction: "inbound" as const,
      channelType: "text" as const,
      senderType: "customer" as const,
      senderMemberId: null,
      body: "Hello",
      outboundStatus: null,
      providerMessageId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      mediaFileId: null,
      mediaMimeType: null,
      mediaDurationSeconds: null,
    };
    const state = initialThreadState([hydratedTextMessage], false);
    const rawTextUpdateRow = {
      id: "m2",
      direction: "inbound",
      channel_type: "text",
      sender_type: "customer",
      body: "Hello (edited transcript)",
      created_at: "2026-01-01T00:00:00.000Z",
    };

    const next = applyRealtimeMessagePatch(state, "m2", toRealtimeUpdatePatch(rawTextUpdateRow));

    const updated = next.messages.find((m) => m.id === "m2");
    expect(updated?.body).toBe("Hello (edited transcript)");
    expect(updated?.mediaFileId).toBeNull();
  });

  it("a brand-new INSERT still uses the full mapRealtimeMessageRow shape (media null), unaffected by this correction", () => {
    const inserted = mapRealtimeMessageRow(rawUpdateRow);
    expect(inserted).toHaveProperty("mediaFileId", null);
    expect(inserted).toHaveProperty("mediaMimeType", null);
    expect(inserted).toHaveProperty("mediaDurationSeconds", null);
  });
});
