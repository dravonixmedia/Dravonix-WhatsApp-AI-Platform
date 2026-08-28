import { describe, expect, it } from "vitest";
import {
  accumulateCompanyUsage,
  formatTtsCharacters,
  formatVoiceDuration,
  type CompanyUsage,
} from "../lib/usageDisplay.js";

const COMPANY_ID = "aaaaaaaa-0000-0000-0000-000000000001";

function build(rows: Array<{ metric: string; totalQuantity: number | null }>): CompanyUsage {
  let byCompany = new Map<string, CompanyUsage>();
  for (const row of rows) {
    byCompany = accumulateCompanyUsage(byCompany, {
      companyId: COMPANY_ID,
      companyName: "Dravonix Media",
      metric: row.metric,
      totalQuantity: row.totalQuantity,
    });
  }
  return byCompany.get(COMPANY_ID)!;
}

describe("accumulateCompanyUsage", () => {
  it("sums WhatsApp message metrics into messages", () => {
    const usage = build([
      { metric: "whatsapp_inbound_messages", totalQuantity: 3 },
      { metric: "whatsapp_outbound_messages", totalQuantity: 2 },
      { metric: "whatsapp_template_messages", totalQuantity: 1 },
    ]);
    expect(usage.messages).toBe(6);
  });

  it("never sums text_to_speech_characters into voice duration -- units are structurally different", () => {
    const usage = build([
      { metric: "speech_to_text_seconds", totalQuantity: 10 },
      { metric: "text_to_speech_characters", totalQuantity: 500 },
    ]);
    expect(usage.voiceDurationSeconds).toBe(10);
    expect(usage.ttsCharacters).toBe(500);
  });

  it("never sums voice-duration seconds into ttsCharacters", () => {
    const usage = build([
      { metric: "generated_voice_seconds", totalQuantity: 42 },
      { metric: "text_to_speech_characters", totalQuantity: 100 },
    ]);
    expect(usage.ttsCharacters).toBe(100);
    expect(usage.voiceDurationSeconds).toBe(42);
  });

  it("sums speech_to_text_seconds and generated_voice_seconds together into one voiceDurationSeconds total (P1 stabilization regression)", () => {
    const usage = build([
      { metric: "speech_to_text_seconds", totalQuantity: 12 },
      { metric: "generated_voice_seconds", totalQuantity: 8 },
    ]);
    expect(usage.voiceDurationSeconds).toBe(20);
    expect(usage.voiceDurationMetered).toBe(true);
  });

  it("marks voiceDurationMetered true only once a real speech_to_text_seconds or generated_voice_seconds row is observed", () => {
    const unmetered = build([{ metric: "text_to_speech_characters", totalQuantity: 200 }]);
    expect(unmetered.voiceDurationMetered).toBe(false);
    expect(unmetered.voiceDurationSeconds).toBe(0);

    const metered = build([{ metric: "speech_to_text_seconds", totalQuantity: 0 }]);
    expect(metered.voiceDurationMetered).toBe(true); // a real zero, not "never measured"
    expect(metered.voiceDurationSeconds).toBe(0);
  });

  it("leaves messages/voice/tts at zero for an unrelated metric (e.g. claude_requests)", () => {
    const usage = build([{ metric: "claude_requests", totalQuantity: 5 }]);
    expect(usage.messages).toBe(0);
    expect(usage.voiceDurationSeconds).toBe(0);
    expect(usage.ttsCharacters).toBe(0);
    expect(usage.voiceDurationMetered).toBe(false);
    expect(usage.ttsMetered).toBe(false);
  });
});

describe("formatVoiceDuration", () => {
  it("never presents an absent duration metric as a verified zero", () => {
    expect(formatVoiceDuration({ voiceDurationMetered: false, voiceDurationSeconds: 0 })).toBe(
      "Voice duration not metered",
    );
  });

  it("presents a real recorded duration as seconds", () => {
    expect(formatVoiceDuration({ voiceDurationMetered: true, voiceDurationSeconds: 37 })).toBe(
      "37s voice",
    );
  });

  it("presents a genuinely recorded zero duration as 0s, not as unmetered", () => {
    expect(formatVoiceDuration({ voiceDurationMetered: true, voiceDurationSeconds: 0 })).toBe(
      "0s voice",
    );
  });
});

describe("formatTtsCharacters", () => {
  it("always presents TTS usage as a character count, never seconds", () => {
    expect(formatTtsCharacters({ ttsCharacters: 1234 })).toBe("1234 TTS characters");
  });

  it("presents zero TTS usage as a real zero (this metric is genuinely instrumented, unlike duration)", () => {
    expect(formatTtsCharacters({ ttsCharacters: 0 })).toBe("0 TTS characters");
  });
});
