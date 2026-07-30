import { describe, expect, it } from "vitest";
import { resolveReplyMode, type ReplyModeInput } from "../src/replyMode.js";

function baseInput(overrides: Partial<ReplyModeInput> = {}): ReplyModeInput {
  return {
    incomingMessageType: "text",
    companyDefaultReplyMode: "auto",
    contactPreference: null,
    voiceEnabledForCompany: true,
    voiceEntitledByPlan: true,
    voiceUsageHeadroomAvailable: true,
    isSuspended: false,
    voiceProviderAvailable: true,
    ...overrides,
  };
}

describe("resolveReplyMode", () => {
  it("defaults a text message to a text-only reply", () => {
    const result = resolveReplyMode(baseInput({ incomingMessageType: "text" }));
    expect(result).toEqual({ mode: "text_only", downgraded: false, downgradeReason: null });
  });

  it("defaults a voice message to a text-and-voice reply", () => {
    const result = resolveReplyMode(baseInput({ incomingMessageType: "audio" }));
    expect(result).toEqual({ mode: "text_and_voice", downgraded: false, downgradeReason: null });
  });

  it("honors an explicit company default of voice_only", () => {
    const result = resolveReplyMode(
      baseInput({ incomingMessageType: "text", companyDefaultReplyMode: "voice_only" }),
    );
    expect(result.mode).toBe("voice_only");
  });

  it("lets a contact's remembered preference override the company default", () => {
    const result = resolveReplyMode(
      baseInput({
        incomingMessageType: "text",
        companyDefaultReplyMode: "text_only",
        contactPreference: "text_and_voice",
      }),
    );
    expect(result.mode).toBe("text_and_voice");
  });

  it("honors a contact's explicit text_only preference", () => {
    const result = resolveReplyMode(
      baseInput({
        incomingMessageType: "audio",
        companyDefaultReplyMode: "text_and_voice",
        contactPreference: "text_only",
      }),
    );
    expect(result.mode).toBe("text_only");
  });

  it("downgrades to text_only when the company has voice disabled", () => {
    const result = resolveReplyMode(
      baseInput({ incomingMessageType: "audio", voiceEnabledForCompany: false }),
    );
    expect(result).toEqual({
      mode: "text_only",
      downgraded: true,
      downgradeReason: "voice_disabled_for_company",
    });
  });

  it("downgrades to text_only when the plan does not include voice", () => {
    const result = resolveReplyMode(
      baseInput({ incomingMessageType: "audio", voiceEntitledByPlan: false }),
    );
    expect(result.downgradeReason).toBe("plan_missing_voice");
  });

  it("downgrades to text_only when the company is suspended", () => {
    const result = resolveReplyMode(baseInput({ incomingMessageType: "audio", isSuspended: true }));
    expect(result.downgradeReason).toBe("company_suspended");
  });

  it("downgrades to text_only when the voice usage limit is reached", () => {
    const result = resolveReplyMode(
      baseInput({ incomingMessageType: "audio", voiceUsageHeadroomAvailable: false }),
    );
    expect(result.downgradeReason).toBe("usage_limit_reached");
  });

  it("downgrades to text_only when the voice provider is unavailable", () => {
    const result = resolveReplyMode(
      baseInput({ incomingMessageType: "audio", voiceProviderAvailable: false }),
    );
    expect(result.downgradeReason).toBe("voice_provider_unavailable");
  });

  it("never downgrades a text_only resolution (nothing to downgrade)", () => {
    const result = resolveReplyMode(
      baseInput({ incomingMessageType: "text", voiceEnabledForCompany: false }),
    );
    expect(result).toEqual({ mode: "text_only", downgraded: false, downgradeReason: null });
  });
});
