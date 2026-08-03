import type { ConversationThreadMessage } from "@dravonix/handover";
import { describe, expect, it } from "vitest";
import {
  initialThreadState,
  oldestCursor,
  prependOlderPage,
} from "../app/dashboard/handover/[conversationId]/threadPagination.js";

function msg(id: string, createdAt: string): ConversationThreadMessage {
  return {
    id,
    direction: "inbound",
    channelType: "text",
    senderType: "customer",
    senderMemberId: null,
    body: id,
    outboundStatus: null,
    providerMessageId: null,
    createdAt,
  };
}

describe("threadPagination", () => {
  it("initialThreadState reflects the server-provided initial page as-is", () => {
    const messages = [msg("m1", "2026-01-01T00:00:00.000Z"), msg("m2", "2026-01-01T00:01:00.000Z")];
    const state = initialThreadState(messages, true);
    expect(state.messages).toEqual(messages);
    expect(state.hasMore).toBe(true);
  });

  it("oldestCursor returns the createdAt of the oldest (first, since ascending) loaded message", () => {
    const state = initialThreadState(
      [msg("m1", "2026-01-01T00:00:00.000Z"), msg("m2", "2026-01-01T00:01:00.000Z")],
      false,
    );
    expect(oldestCursor(state)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("oldestCursor is null when nothing is loaded yet", () => {
    expect(oldestCursor(initialThreadState([], false))).toBeNull();
  });

  it("prependOlderPage puts the older page before the existing messages, preserving ascending order", () => {
    const current = initialThreadState([msg("m3", "2026-01-01T00:02:00.000Z")], true);
    const older = {
      messages: [msg("m1", "2026-01-01T00:00:00.000Z"), msg("m2", "2026-01-01T00:01:00.000Z")],
      hasMore: false,
    };
    const next = prependOlderPage(current, older);
    expect(next.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(next.hasMore).toBe(false);
  });

  it("prependOlderPage never duplicates a message id already present", () => {
    const current = initialThreadState(
      [msg("m2", "2026-01-01T00:01:00.000Z"), msg("m3", "2026-01-01T00:02:00.000Z")],
      true,
    );
    // A boundary tie / stale refetch could hand back m2 again alongside a
    // genuinely new m1 -- the overlapping id must never appear twice.
    const older = {
      messages: [msg("m1", "2026-01-01T00:00:00.000Z"), msg("m2", "2026-01-01T00:01:00.000Z")],
      hasMore: false,
    };
    const next = prependOlderPage(current, older);
    expect(next.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    const ids = next.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hasMore becomes false once the server reports no older page remains", () => {
    const current = initialThreadState([msg("m2", "2026-01-01T00:01:00.000Z")], true);
    const next = prependOlderPage(current, {
      messages: [msg("m1", "2026-01-01T00:00:00.000Z")],
      hasMore: false,
    });
    expect(next.hasMore).toBe(false);
    expect(oldestCursor(next)).toBe("2026-01-01T00:00:00.000Z");
  });
});
