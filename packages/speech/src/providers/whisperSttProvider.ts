import type { SpeechToTextInput, SpeechToTextProvider, SpeechToTextResult } from "../provider.js";

export interface WhisperSttConfig {
  apiKey: string;
  /** Overridable for tests; defaults to the real OpenAI transcriptions endpoint. */
  baseUrl?: string;
}

/**
 * OpenAI Whisper (audio/transcriptions) adapter. Chosen over Google STT for
 * WhatsApp voice notes for two reasons: it accepts Ogg/Opus files directly and
 * determines the sample rate itself (no header to parse or rate to declare --
 * the entire class of bug we hit with Google's API), and it handles
 * colloquial/code-switched regional speech (e.g. Malayalam slang) noticeably
 * better than Google's standard recognition model.
 */
export class WhisperSpeechToTextProvider implements SpeechToTextProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: WhisperSttConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1/audio/transcriptions";
  }

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    const formData = new FormData();
    formData.append("file", new Blob([input.audio], { type: input.mimeType }), "voice-note.ogg");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");
    // Deliberately not passing a "language" hint: Whisper's own language
    // auto-detection is reliable and handles mixed/code-switched speech well.
    // Forcing a hint based on the company's configured primary language would
    // actively hurt accuracy whenever the customer speaks a different one of
    // their enabled languages -- exactly the scenario multi-language support
    // exists for.

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI Whisper request failed with status ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { text?: string; language?: string };

    return {
      text: data.text?.trim() ?? "",
      detectedLanguageCode: data.language ?? null,
      // Whisper's transcription API does not return a confidence score.
      confidence: null,
    };
  }
}
