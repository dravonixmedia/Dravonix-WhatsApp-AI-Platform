import { describe, expect, it, vi } from "vitest";
import { recordAiUsage, type AiUsageRecorder } from "../src/usage.js";

describe("recordAiUsage", () => {
  it("passes the input through to the recorder unchanged", async () => {
    const recorder: AiUsageRecorder = { recordAiUsage: vi.fn().mockResolvedValue(undefined) };
    const input = {
      companyId: "company-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      requestCount: 1,
      requestSucceeded: true,
    };

    await recordAiUsage(recorder, input);

    expect(recorder.recordAiUsage).toHaveBeenCalledWith(input);
    expect(recorder.recordAiUsage).toHaveBeenCalledTimes(1);
  });

  it("propagates a recorder failure to the caller", async () => {
    const recorder: AiUsageRecorder = {
      recordAiUsage: vi.fn().mockRejectedValue(new Error("db unavailable")),
    };
    await expect(
      recordAiUsage(recorder, {
        companyId: "company-1",
        conversationId: null,
        messageId: "message-1",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        requestCount: 1,
        requestSucceeded: true,
      }),
    ).rejects.toThrow("db unavailable");
  });
});
