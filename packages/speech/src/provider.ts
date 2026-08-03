export interface SpeechToTextInput {
  audio: ArrayBuffer;
  mimeType: string;
  /** Primary language hint, e.g. "ml-IN". Sourced from the company's enabled languages. */
  languageCode: string;
  /** Additional hints for mixed-language speech (Master Prompt section 5: Malayalam-English mixed). */
  alternativeLanguageCodes?: string[];
  /**
   * When set, forces this exact provider-recognized language code (e.g.
   * "ml") instead of letting the provider auto-detect -- used only when the
   * caller is already confident about the spoken language (e.g. a
   * Malayalam-only company, or a conversation whose last detected language
   * was confidently Malayalam). Omitted for genuinely mixed-language audio,
   * where auto-detection plus `keyterms` below gives better accuracy than
   * forcing a single language.
   */
  forceLanguageCode?: string;
  /**
   * Domain-specific terms (company/product names, technical vocabulary) to
   * bias transcription accuracy for auto-detected/mixed-language audio.
   * Ignored by providers that don't support a keyterms hint.
   */
  keyterms?: string[];
}

export interface SpeechToTextResult {
  text: string;
  detectedLanguageCode: string | null;
  confidence: number | null;
}

export interface SpeechToTextProvider {
  /** Stable identifier for whichever vendor this implementation calls (e.g. "elevenlabs", "whisper", "google"), recorded alongside each transcription so the audit trail can never drift out of sync with which provider actually produced it. */
  readonly providerName: string;
  transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult>;
}

export interface TextToSpeechInput {
  text: string;
  languageCode: string;
  voiceId?: string;
  speakingRate?: number;
}

export interface TextToSpeechResult {
  audio: ArrayBuffer;
  mimeType: string;
}

export interface TextToSpeechProvider {
  synthesize(input: TextToSpeechInput): Promise<TextToSpeechResult>;
}
