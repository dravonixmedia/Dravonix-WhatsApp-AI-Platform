import { describe, expect, it } from "vitest";
import {
  CHAT_AGENT_MAX_HISTORY_CHARS,
  CHAT_AGENT_MAX_HISTORY_MESSAGES,
  selectBoundedHistory,
} from "../../src/chatAgent/historySelection.js";
import type { ChatAgentMessage } from "../../src/chatAgent/types.js";

function message(body: string, createdAt: string): ChatAgentMessage {
  return { direction: "inbound", senderType: "customer", body, createdAt };
}

describe("selectBoundedHistory", () => {
  it("keeps every message when under both caps, unmarked as truncated", () => {
    const messages = [
      message("hi", "2026-01-01T00:00:00Z"),
      message("bye", "2026-01-01T00:01:00Z"),
    ];
    const result = selectBoundedHistory(messages);
    expect(result.messages).toEqual(messages);
    expect(result.truncated).toBe(false);
  });

  it("caps by message count, keeping the most recent N in chronological order", () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      message(`msg-${i}`, `2026-01-01T00:0${i}:00Z`),
    );
    const result = selectBoundedHistory(messages, { maxMessages: 3 });
    expect(result.messages.map((m) => m.body)).toEqual(["msg-2", "msg-3", "msg-4"]);
    expect(result.truncated).toBe(true);
  });

  it("caps by total character budget, keeping the most recent messages", () => {
    const messages = [
      message("a".repeat(50), "2026-01-01T00:00:00Z"),
      message("b".repeat(50), "2026-01-01T00:01:00Z"),
      message("c".repeat(50), "2026-01-01T00:02:00Z"),
    ];
    const result = selectBoundedHistory(messages, { maxTotalChars: 120 });
    // Most recent (c) always included; then b fits (50+50=100 <= 120); a would push to 150 > 120, dropped.
    expect(result.messages.map((m) => m.body[0])).toEqual(["b", "c"]);
    expect(result.truncated).toBe(true);
  });

  it("always includes at least the single most recent message even if it alone exceeds the char budget", () => {
    const messages = [message("x".repeat(500), "2026-01-01T00:00:00Z")];
    const result = selectBoundedHistory(messages, { maxTotalChars: 10 });
    expect(result.messages).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it("preserves chronological (ascending) order in the returned window", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      message(`msg-${i}`, `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`),
    );
    const result = selectBoundedHistory(messages, { maxMessages: 4 });
    const bodies = result.messages.map((m) => m.body);
    expect(bodies).toEqual(["msg-6", "msg-7", "msg-8", "msg-9"]);
    expect([...bodies].sort()).not.toEqual(bodies.slice().reverse()); // sanity: not reversed
  });

  it("returns empty, non-truncated for an empty conversation", () => {
    const result = selectBoundedHistory([]);
    expect(result.messages).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("uses the documented default bounds when none are supplied", () => {
    const messages = Array.from({ length: CHAT_AGENT_MAX_HISTORY_MESSAGES + 10 }, (_, i) =>
      message(`m${i}`, new Date(i * 1000).toISOString()),
    );
    const result = selectBoundedHistory(messages);
    expect(result.messages.length).toBeLessThanOrEqual(CHAT_AGENT_MAX_HISTORY_MESSAGES);
    expect(result.truncated).toBe(true);
    const totalChars = result.messages.reduce((sum, m) => sum + m.body.length, 0);
    expect(totalChars).toBeLessThanOrEqual(CHAT_AGENT_MAX_HISTORY_CHARS);
  });
});
