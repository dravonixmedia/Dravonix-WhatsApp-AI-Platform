import { describe, expect, it } from "vitest";
import { createLogger, type LogSink } from "../src/logger.js";

function captureSink() {
  const lines: string[] = [];
  const sink: LogSink = { write: (line) => lines.push(line) };
  return { lines, sink };
}

describe("createLogger", () => {
  it("writes a structured JSON line with severity, context, and message", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ environment: "test", companyId: "c-1" }, sink);

    logger.info("message received", { messageId: "m-1" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.severity).toBe("info");
    expect(parsed.companyId).toBe("c-1");
    expect(parsed.message).toBe("message received");
    expect(parsed.messageId).toBe("m-1");
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("redacts sensitive extra fields before writing", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ environment: "test" }, sink);

    logger.error("provider call failed", { apiKey: "sk-ant-secret" });

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.apiKey).toBe("[REDACTED]");
  });

  it("child() merges additional context for subsequent log lines", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ environment: "test", companyId: "c-1" }, sink);
    const child = logger.child({ conversationId: "conv-1" });

    child.info("handling message");

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.companyId).toBe("c-1");
    expect(parsed.conversationId).toBe("conv-1");
  });

  it("supports all four severities", () => {
    const { lines, sink } = captureSink();
    const logger = createLogger({ environment: "test" }, sink);

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    const severities = lines.map((line) => JSON.parse(line).severity);
    expect(severities).toEqual(["debug", "info", "warn", "error"]);
  });
});
