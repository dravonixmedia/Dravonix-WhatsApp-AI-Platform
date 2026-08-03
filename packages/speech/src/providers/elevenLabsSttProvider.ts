import type { SpeechToTextInput, SpeechToTextProvider, SpeechToTextResult } from "../provider.js";

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
    if (input.keyterms && input.keyterms.length > 0) {
      formData.append("keyterms", JSON.stringify(input.keyterms));
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "xi-api-key": this.config.apiKey },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `ElevenLabs speech-to-text request failed with status ${response.status}: ${body}`,
      );
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
