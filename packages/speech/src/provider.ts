export interface SpeechToTextInput {
  audio: ArrayBuffer;
  mimeType: string;
  /** Primary language hint, e.g. "ml-IN". Sourced from the company's enabled languages. */
  languageCode: string;
  /** Additional hints for mixed-language speech (Master Prompt section 5: Malayalam-English mixed). */
  alternativeLanguageCodes?: string[];
}

export interface SpeechToTextResult {
  text: string;
  detectedLanguageCode: string | null;
  confidence: number | null;
}

export interface SpeechToTextProvider {
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
