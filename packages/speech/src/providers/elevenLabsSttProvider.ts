import { sanitizeKeyterms } from "../keytermSanitizer.js";
import type { SpeechToTextInput, SpeechToTextProvider, SpeechToTextResult } from "../provider.js";
import { elevenLabsErrorFromStatus, elevenLabsNetworkError } from "./elevenLabsError.js";

export interface ElevenLabsSttConfig {
  apiKey: string;
  /** ElevenLabs STT model, e.g. "scribe_v2". */
  modelId: string;
  /** Overridable for tests; defaults to the real ElevenLabs speech-to-text endpoint. */
  baseUrl?: string;
}

/**
 * ElevenLabs Scribe speech-to-text adapter (Scribe v2). Accepts Ogg/Opus
 * directly (no sample rate to declare, unlike Google's STT API) and
 * auto-detects the spoken language by default -- forcing one based purely on
 * the company's configured primary language would hurt accuracy whenever a
 * customer speaks a different one of their enabled languages. `language_code`
 * is only sent when the caller explicitly opts in via `forceLanguageCode`
 * (used when confidently Malayalam), and `keyterms` biases auto-detected/
 * mixed-language transcription toward known business vocabulary.
 */
export class ElevenLabsSpeechToTextProvider implements SpeechToTextProvider {
  readonly providerName = "elevenlabs";
  private readonly baseUrl: string;

  constructor(private readonly config: ElevenLabsSttConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io/v1/speech-to-text";
  }

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    const formData = new FormData();
    formData.append("file", new Blob([input.audio], { type: input.mimeType }), "voice-note.ogg");
    formData.append("model_id", this.config.modelId);

    // Only sent when the caller is already confident about the spoken
    // language (see SpeechToTextInput.forceLanguageCode) -- otherwise this is
    // omitted entirely so ElevenLabs auto-detects, which is more accurate for
    // genuinely mixed-language audio than forcing a single language.
    if (input.forceLanguageCode) {
      formData.append("language_code", input.forceLanguageCode);
    }
    // Re-validated here regardless of what the caller already did (defense
    // in depth, per the 2026-08-04 incident) -- an invalid, oversized, or
    // malformed keyterm must never reach ElevenLabs and must never fail this
    // request. Only the sanitized survivors are ever sent.
    //
    // Each survivor is appended as its own "keyterms" form entry -- the
    // standard multipart representation for a list field -- rather than as
    // one JSON.stringify'd blob under a single entry. The blob form was the
    // actual defect behind the 2026-08-04 incident: ElevenLabs validated the
    // *entire serialized array string* as if it were a single keyword, so
    // even an array of individually-short terms produced one combined value
    // well over its 50-character keyword limit. Per-term sanitization alone
    // cannot fix that; only sending discrete entries can. The parameter is
    // omitted entirely once no valid terms remain.
    const { keyterms } = sanitizeKeyterms(input.keyterms);
    for (const term of keyterms) {
      formData.append("keyterms", term);
    }

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "xi-api-key": this.config.apiKey },
        body: formData,
      });
    } catch (error) {
      // Network-level failure (timeout, connection reset, DNS) -- no
      // response to classify, always retryable. Never logs `error` itself
      // upstream of this point since it may embed request detail.
      throw elevenLabsNetworkError("speech-to-text", error);
    }

    if (!response.ok) {
      // The raw response body is deliberately never read here -- it may
      // contain verbose account/request detail (voice pipeline reliability
      // phase 7). Classification is status-code-only.
      throw elevenLabsErrorFromStatus("speech-to-text", response.status);
    }

    const data = (await response.json()) as {
      text?: string;
      language_code?: string;
      language_probability?: number;
    };

    return {
      text: data.text?.trim() ?? "",
      detectedLanguageCode: data.language_code ?? null,
      confidence: data.language_probability ?? null,
    };
  }
}
