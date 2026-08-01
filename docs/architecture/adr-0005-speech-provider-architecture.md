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
- `GoogleTextToSpeechProvider` implements `TextToSpeechProvider` using the Google
  Cloud Text-to-Speech REST API, selected when `GOOGLE_CLOUD_CREDENTIALS` is
  configured. `GoogleSpeechToTextProvider` implements `SpeechToTextProvider` the
  same way and remains available, but production STT now uses
  `WhisperSpeechToTextProvider` instead -- see Update below.
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

## Update: STT switched to Whisper

Production STT (`apps/workers/voice-consumer`'s composition root) now injects
`WhisperSpeechToTextProvider` (OpenAI `audio/transcriptions`, requires
`OPENAI_API_KEY`) instead of `GoogleSpeechToTextProvider`, for two reasons
confirmed against real WhatsApp voice notes:

- Whisper accepts Ogg/Opus directly and determines the sample rate itself.
  Google's API requires an explicit `sampleRateHertz` that must match the
  file's actual encoding, and direct inspection of a real WhatsApp voice note's
  Ogg Opus header found it declares 24000 Hz -- not a value that can be safely
  assumed for every client/version, and wrong twice before this was confirmed.
- Whisper handles colloquial/code-switched regional speech (e.g. Malayalam
  slang) noticeably better than Google's standard recognition model in
  practice, and auto-detects language reliably enough that no `languageCode`
  hint is sent (forcing one would actively hurt accuracy whenever a customer
  speaks a different one of their enabled languages).

TTS is unchanged (still Google) since no equivalent issue was observed there.
`GoogleSpeechToTextProvider` and its test coverage remain in `packages/speech`
as a working alternative implementation, just not the one wired into
`voice-consumer` today.
