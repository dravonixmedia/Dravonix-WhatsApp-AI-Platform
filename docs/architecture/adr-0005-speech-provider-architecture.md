# ADR-0005: Speech provider architecture

## Status

Accepted

## Context

Voice notes must be transcribed (STT) and, for voice replies, synthesized (TTS),
across English, Malayalam, Malayalam-English mixed speech, Hindi and Arabic, while
running in a Cloudflare Workers environment where bundling FFmpeg is impractical.

## Decision

- `packages/speech` defines provider-agnostic interfaces:
  ```typescript
  interface SpeechToTextProvider {
    transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult>;
  }
  interface TextToSpeechProvider {
    synthesize(input: TextToSpeechInput): Promise<TextToSpeechResult>;
  }
  ```
- `GoogleSpeechToTextProvider` / `GoogleTextToSpeechProvider` implement these using
  Google Cloud Speech-to-Text / Text-to-Speech REST APIs, selected when
  `GOOGLE_CLOUD_CREDENTIALS` is configured.
- `MockSpeechToTextProvider` / `MockTextToSpeechProvider` implement the same
  interfaces deterministically, used in tests and local development without Google
  credentials.
- TTS output is requested directly in OGG/Opus where the provider supports it, so
  WhatsApp voice messages can be sent without a transcoding step. Format
  conversion, if ever required for a provider that can't emit OGG/Opus directly, is
  isolated behind the same `TextToSpeechProvider` interface and delegated to a
  separate compatible processing service — never bundled as an in-Worker FFmpeg
  dependency.
- Language handling: STT requests carry configurable language hints
  (`languageCode`, optional `alternativeLanguageCodes`) sourced from the company's
  enabled-languages setting; the result carries a detected language + confidence,
  stored on the message/transcription row, correctable by a human agent.
  Malayalam-English mixed speech is handled by including `ml-IN` with English
  alternatives rather than forcing translation to English.
- Voice generation picks a language-specific voice from `voice_settings`
  (`defaultVoiceByLanguage`), with a configurable fallback voice/language.
- Every STT/TTS call is gated by the suspension/entitlement guard (ADR-0006) before
  it happens — a suspended company or one without voice entitlement never reaches
  the provider call.

## Consequences

- Real Malayalam/Arabic/Hindi accuracy validation requires actual sample audio and
  a live Google Cloud credential; this is out of scope for this offline development
  session and is tracked as an outstanding limitation in `TASKS.md`.
- Adding a second STT/TTS vendor later (e.g. for cost or accuracy reasons in a
  specific language) means a new adapter, no changes to `voice-consumer` or the
  reply-mode resolution logic.
