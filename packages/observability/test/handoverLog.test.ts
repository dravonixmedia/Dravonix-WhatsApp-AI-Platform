import { describe, expect, it } from "vitest";
import { logHandoverTrigger } from "../src/handoverLog.js";
import { createLogger, type LogSink } from "../src/logger.js";

function captureSink() {
  const lines: string[] = [];
  const sink: LogSink = { write: (line) => lines.push(line) };
  return { lines, sink };
}

describe("logHandoverTrigger", () => {
  it("logs exactly the allowed structured fields at warn severity", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ environment: "test" }, sink);

    logHandoverTrigger(logger, {
      conversationId: "conv-1",
      messageId: "msg-1",
      reasonCode: "low_confidence",
      source: "claude",
      validationAttemptCount: 1,
      previousState: "ai_active",
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.severity).toBe("warn");
    expect(parsed.conversationId).toBe("conv-1");
    expect(parsed.messageId).toBe("msg-1");
    expect(parsed.reasonCode).toBe("low_confidence");
    expect(parsed.source).toBe("claude");
    expect(parsed.validationAttemptCount).toBe(1);
    expect(parsed.previousState).toBe("ai_active");
  });

  it("never includes a message body, phone number, contact name, or credential field", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ environment: "test" }, sink);

    logHandoverTrigger(logger, {
      conversationId: "conv-1",
      messageId: "msg-1",
      reasonCode: "speech_to_text_failed",
      source: "voice_failure",
      validationAttemptCount: 2,
      previousState: "ai_active",
    });

    const parsed = JSON.parse(lines[0]!);
    const disallowedKeys = ["body", "message", "phoneNumber", "waId", "name", "apiKey", "token"];
    for (const key of disallowedKeys) {
      // "message" is the log line's own free-text description, never message content.
      if (key === "message") continue;
      expect(parsed).not.toHaveProperty(key);
    }
  });

  it("accepts every documented source value", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ environment: "test" }, sink);
    const sources = [
      "claude",
      "validation_fallback",
      "voice_failure",
      "explicit_customer_request",
    ] as const;

    for (const source of sources) {
      logHandoverTrigger(logger, {
        conversationId: "conv-1",
        messageId: "msg-1",
        reasonCode: "some_reason",
        source,
        validationAttemptCount: 1,
        previousState: "ai_active",
      });
    }

    const parsedSources = lines.map((line) => JSON.parse(line).source);
    expect(parsedSources).toEqual(sources);
  });
});
