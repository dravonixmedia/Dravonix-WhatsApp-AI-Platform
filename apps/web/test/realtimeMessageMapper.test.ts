import { describe, expect, it } from "vitest";
import { mapRealtimeMessageRow } from "../app/dashboard/handover/[conversationId]/realtimeMessageMapper.js";

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
