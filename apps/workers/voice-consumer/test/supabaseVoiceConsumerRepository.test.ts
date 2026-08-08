import { describe, expect, it, vi } from "vitest";
import { SupabaseVoiceConsumerRepository } from "../src/repositories/supabaseVoiceConsumerRepository.js";

/**
 * Minimal chainable double for the Supabase query-builder shape this
 * repository actually calls (.select/.eq/.insert/.update all return the
 * builder itself; .maybeSingle()/.single() are the only awaited terminals).
 * Not a general-purpose Supabase client fake -- scoped tightly to what
 * recordTranscription's canonical-text race fix needs to prove.
 */
function chain(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "insert", "update"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => result);
  builder.single = vi.fn(async () => result);
  return builder;
}

const UNIQUE_VIOLATION = {
  code: "23505",
  message: "duplicate key value violates unique constraint",
};

describe("SupabaseVoiceConsumerRepository.recordTranscription (canonical-text race fix)", () => {
  it("a losing insert (unique violation) re-queries and converges messages.body to the WINNING row's own persisted text, never the caller's local rawText", async () => {
    // Attempt B: no existing row yet, its own insert loses the race to
    // Attempt A's, and it must resolve/update using Attempt A's text.
    const noExisting = chain({ data: null, error: null });
    const losingInsert = chain({ data: null, error: UNIQUE_VIOLATION });
    const winnerRow = chain({
      data: { raw_text: "Transcript A", detected_language: "en" },
      error: null,
    });
    const messageUpdate = chain({ data: null, error: null });

    const from = vi
      .fn()
      .mockReturnValueOnce(noExisting) // select existing (none)
      .mockReturnValueOnce(losingInsert) // insert (loses race)
      .mockReturnValueOnce(winnerRow) // re-query canonical winner
      .mockReturnValueOnce(messageUpdate); // messages.body update

    const repo = new SupabaseVoiceConsumerRepository({ from } as never);

    await repo.recordTranscription({
      companyId: "company-1",
      messageId: "msg-1",
      mediaFileId: "media-1",
      provider: "elevenlabs",
      rawText: "Transcript B", // this attempt's OWN (losing) local text
      detectedLanguage: "en",
      languageConfidence: 0.9,
    });

    expect(from).toHaveBeenCalledTimes(4);
    expect(messageUpdate.update).toHaveBeenCalledWith({
      body: "Transcript A", // the WINNER's text, never "Transcript B"
      detected_language: "en",
    });
  });

  it("a transcription that already exists before this call uses ITS persisted text, not the caller's local rawText, and never calls insert", async () => {
    const existing = chain({
      data: { raw_text: "Already persisted transcript", detected_language: "ml" },
      error: null,
    });
    const messageUpdate = chain({ data: null, error: null });

    const from = vi.fn().mockReturnValueOnce(existing).mockReturnValueOnce(messageUpdate);

    const repo = new SupabaseVoiceConsumerRepository({ from } as never);

    await repo.recordTranscription({
      companyId: "company-1",
      messageId: "msg-1",
      mediaFileId: "media-1",
      provider: "elevenlabs",
      rawText: "Stale local retry text",
      detectedLanguage: "en",
      languageConfidence: 0.9,
    });

    expect(existing.insert).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(2);
    expect(messageUpdate.update).toHaveBeenCalledWith({
      body: "Already persisted transcript",
      detected_language: "ml",
    });
  });

  it("a successful (winning) insert uses the freshly persisted row's own returned text", async () => {
    const noExisting = chain({ data: null, error: null });
    const wonInsert = chain({
      data: { raw_text: "Transcript A", detected_language: "en" },
      error: null,
    });
    const messageUpdate = chain({ data: null, error: null });

    const from = vi
      .fn()
      .mockReturnValueOnce(noExisting)
      .mockReturnValueOnce(wonInsert)
      .mockReturnValueOnce(messageUpdate);

    const repo = new SupabaseVoiceConsumerRepository({ from } as never);

    await repo.recordTranscription({
      companyId: "company-1",
      messageId: "msg-1",
      mediaFileId: "media-1",
      provider: "elevenlabs",
      rawText: "Transcript A",
      detectedLanguage: "en",
      languageConfidence: 0.9,
    });

    expect(from).toHaveBeenCalledTimes(3);
    expect(messageUpdate.update).toHaveBeenCalledWith({
      body: "Transcript A",
      detected_language: "en",
    });
  });

  it("only an actual Postgres unique violation (23505) is treated as a race loss -- any other insert error still throws", async () => {
    const noExisting = chain({ data: null, error: null });
    const genuineFailure = chain({
      data: null,
      error: { code: "42501", message: "permission denied" },
    });

    const from = vi.fn().mockReturnValueOnce(noExisting).mockReturnValueOnce(genuineFailure);
    const repo = new SupabaseVoiceConsumerRepository({ from } as never);

    await expect(
      repo.recordTranscription({
        companyId: "company-1",
        messageId: "msg-1",
        mediaFileId: "media-1",
        provider: "elevenlabs",
        rawText: "Transcript A",
        detectedLanguage: "en",
        languageConfidence: 0.9,
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("never updates corrected_text -- the message-body sync only ever writes body/detected_language", async () => {
    const existing = chain({ data: { raw_text: "text", detected_language: "en" }, error: null });
    const messageUpdate = chain({ data: null, error: null });
    const from = vi.fn().mockReturnValueOnce(existing).mockReturnValueOnce(messageUpdate);
    const repo = new SupabaseVoiceConsumerRepository({ from } as never);

    await repo.recordTranscription({
      companyId: "company-1",
      messageId: "msg-1",
      mediaFileId: "media-1",
      provider: "elevenlabs",
      rawText: "text",
      detectedLanguage: "en",
      languageConfidence: 0.9,
    });

    const updateCall = (messageUpdate.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(updateCall).not.toHaveProperty("corrected_text");
    expect(Object.keys(updateCall)).toEqual(["body", "detected_language"]);
  });
});
