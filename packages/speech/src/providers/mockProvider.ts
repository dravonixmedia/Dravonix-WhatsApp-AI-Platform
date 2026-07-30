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
  public fixedText = "This is a mock transcription.";

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    return {
      text: this.fixedText,
      detectedLanguageCode: input.languageCode,
      confidence: 0.95,
    };
  }
}

/** Deterministic mock TTS provider for local development and tests. */
export class MockTextToSpeechProvider implements TextToSpeechProvider {
  async synthesize(input: TextToSpeechInput): Promise<TextToSpeechResult> {
    return {
      audio: new TextEncoder().encode(`MOCK_AUDIO:${input.text}`).buffer,
      mimeType: "audio/ogg",
    };
  }
}
