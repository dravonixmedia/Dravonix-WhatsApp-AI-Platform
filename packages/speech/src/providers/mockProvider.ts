import type {
  SpeechToTextInput,
  SpeechToTextProvider,
  SpeechToTextResult,
  TextToSpeechInput,
  TextToSpeechProvider,
  TextToSpeechResult,
} from "../provider.js";

/** Deterministic mock STT provider for local development and tests. */
export class MockSpeechToTextProvider implements SpeechToTextProvider {
  readonly providerName = "mock";
  public fixedText = "This is a mock transcription.";
  /**
   * When set, returned as-is instead of echoing back the requested
   * languageCode -- mirrors ElevenLabs' real behavior of auto-detecting the
   * spoken language and ignoring any language hint (see
   * ElevenLabsSpeechToTextProvider), so tests can simulate a detected
   * language that differs from the company's configured primary language.
   */
  public fixedDetectedLanguageCode: string | null = null;

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    return {
      text: this.fixedText,
      detectedLanguageCode: this.fixedDetectedLanguageCode ?? input.languageCode,
      confidence: 0.95,
    };
  }
}

/** Deterministic mock TTS provider for local development and tests. */
export class MockTextToSpeechProvider implements TextToSpeechProvider {
  /** Every synthesize() call, in order -- lets tests assert exactly what text/languageCode/voiceId was actually sent. */
  public calls: TextToSpeechInput[] = [];

  async synthesize(input: TextToSpeechInput): Promise<TextToSpeechResult> {
    this.calls.push(input);
    return {
      audio: new TextEncoder().encode(`MOCK_AUDIO:${input.text}`).buffer,
      mimeType: "audio/ogg",
    };
  }
}
