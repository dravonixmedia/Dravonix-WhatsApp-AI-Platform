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
- `GoogleTextToSpeechProvider` / `GoogleSpeechToTextProvider` implement
  `TextToSpeechProvider` / `SpeechToTextProvider` using the Google Cloud
  REST APIs. Both remain available as working alternative implementations,
  but neither is what production is wired to today -- see Update below.
- `MockSpeechToTextProvider` / `MockTextToSpeechProvider` implement the same
  interfaces deterministically, used in tests and local development without
  any real provider credentials.
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

## Update history

1. **STT switched from Google to Whisper (OpenAI).** Google's STT API
   requires an explicit `sampleRateHertz` matching the audio's actual
   encoding, and direct inspection of a real WhatsApp voice note's Ogg Opus
   header found it declares 24000 Hz -- not a value safely assumed for every
   client/version, and wrong twice (16000, then 48000) before this was
   confirmed. Whisper accepts Ogg/Opus directly and determines the sample
   rate itself, sidestepping the problem entirely.
2. **Both STT and TTS switched to ElevenLabs.** Whisper handled the sample
   rate problem, but a real Malayalam voice note with colloquial/slang speech
   still came back with an empty transcript. ElevenLabs (Scribe for STT) was
   evaluated next and confirmed working against that same audio. TTS was
   switched to ElevenLabs at the same time for voice-reply quality (more
   natural-sounding than Google's standard Neural2 voices), not because of a
   specific bug.

**Current state**: `apps/workers/voice-consumer`'s composition root injects
`ElevenLabsSpeechToTextProvider` and `ElevenLabsTextToSpeechProvider`
(both requiring `ELEVENLABS_API_KEY` -- see `ELEVENLABS_SETUP.md`) for both
directions of the voice pipeline. Neither auto-detected-language provider
(Whisper, ElevenLabs) is sent a `languageCode` hint -- forcing one based on
the company's configured primary language would hurt accuracy whenever a
customer speaks a different one of their enabled languages, which is exactly
the case multi-language support exists for.

`GoogleSpeechToTextProvider`, `GoogleTextToSpeechProvider`, and
`WhisperSpeechToTextProvider` all remain in `packages/speech` with their test
coverage intact, as working alternative implementations -- just not the ones
wired into `voice-consumer` today. Swapping again later is a change to that
one composition root file, per the Consequences section above.
