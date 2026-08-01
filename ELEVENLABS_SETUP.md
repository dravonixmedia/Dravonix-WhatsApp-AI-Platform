# ELEVENLABS_SETUP.md

ElevenLabs is the default speech provider for both directions of the voice
pipeline in `apps/workers/voice-consumer`:

- **Speech-to-text**: transcribing inbound WhatsApp voice notes
  (`ElevenLabsSpeechToTextProvider`, Scribe model).
- **Text-to-speech**: synthesizing spoken voice replies
  (`ElevenLabsTextToSpeechProvider`).

Claude remains the chatbot reasoning/response-generation engine throughout —
ElevenLabs only ever sees the transcript on the way in and the customer-facing
answer text on the way out, never internal notes, JSON, source IDs, or system
prompts (`processVoiceJob.ts` only ever passes `response.answer` to TTS).

See `docs/architecture/adr-0005-speech-provider-architecture.md` for why
ElevenLabs was chosen over Google STT/TTS and OpenAI Whisper.

## 1. Create an account and API key

1. Create (or reuse) an ElevenLabs account.
2. Go to Settings → API Keys and create a new key.
   - Scope it to only what this integration uses (speech-to-text,
     text-to-speech, and read access to list voices/models) if your account
     plan supports restricted key permissions. Avoid a fully unrestricted key
     unless your plan requires it.
3. Note your account's available voice IDs (Voices tab in the ElevenLabs
   dashboard) — you'll need at least one for `ELEVENLABS_VOICE_ID_DEFAULT`.

## 2. Configure environment variables

```
ELEVENLABS_API_KEY=<your API key>
ELEVENLABS_VOICE_ID_DEFAULT=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_TTS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_STT_MODEL_ID=scribe_v1
```

`ELEVENLABS_VOICE_ID_DEFAULT` above (`21m00Tcm4TlvDq8ikWAM`, "Rachel") is
ElevenLabs' commonly-used example voice — replace it with a voice ID from
your own account. Per-language voice selection is handled by each company's
existing `voice_settings.defaultVoiceByLanguage` configuration (see
`DATABASE.md`), not by an environment variable.

Store `ELEVENLABS_API_KEY` as a Cloudflare Worker secret in production
(`wrangler secret put ELEVENLABS_API_KEY` on `apps/workers/voice-consumer`),
never as a plain `[vars]` entry, and never in a committed file. Never expose
it to the browser (no `NEXT_PUBLIC_` prefix, never called from `apps/web`) —
all ElevenLabs calls happen server-side in the Cloudflare Worker.

## Wiring the providers

```typescript
import { ElevenLabsSpeechToTextProvider, ElevenLabsTextToSpeechProvider } from "@dravonix/speech";

const stt = new ElevenLabsSpeechToTextProvider({
  apiKey: env.ELEVENLABS_API_KEY,
  modelId: platformEnv.ELEVENLABS_STT_MODEL_ID,
});

const tts = new ElevenLabsTextToSpeechProvider({
  apiKey: env.ELEVENLABS_API_KEY,
  defaultVoiceId: platformEnv.ELEVENLABS_VOICE_ID_DEFAULT,
  modelId: platformEnv.ELEVENLABS_TTS_MODEL_ID,
});
```

This is exactly what `apps/workers/voice-consumer/src/worker.ts`'s
composition root does. Both classes implement the same
`SpeechToTextProvider`/`TextToSpeechProvider` interfaces as the Google and
Whisper adapters, so swapping providers again later is a one-file change to
that composition root, not a rewrite of `processVoiceJob.ts` or any business
logic.

## Without credentials

If `ELEVENLABS_API_KEY` is unset, `env.elevenLabsConfigured` (from
`@dravonix/config`) is `false` and the composition root should select
`MockSpeechToTextProvider` / `MockTextToSpeechProvider`
(`packages/speech/src/providers/mockProvider.ts`) instead, which return
deterministic results with no network call.

## Testing STT and TTS directly

Speech-to-text (multipart form upload):

```bash
curl -s https://api.elevenlabs.io/v1/speech-to-text \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -F "model_id=scribe_v1" \
  -F "file=@sample-voice-note.ogg"
```

Text-to-speech (writes Opus audio to a file):

```bash
curl -s "https://api.elevenlabs.io/v1/text-to-speech/$ELEVENLABS_VOICE_ID_DEFAULT?output_format=opus_48000_128" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test.", "model_id": "eleven_multilingual_v2"}' \
  -o test-reply.opus
```

Play `test-reply.opus` back and confirm it sounds correct before relying on
it in production. Also confirm generated audio actually uploads and plays
correctly as a WhatsApp voice note via the Meta test number
(`META_TEST_NUMBER_SETUP.md`) — this has been validated for real Malayalam
transcription in this session, but the full quality/format matrix described
in ADR-0005's outstanding-validation note has not.

## Troubleshooting

- **401 / invalid API key** — check the key was copied correctly and hasn't
  been revoked/rotated in the ElevenLabs dashboard.
- **402 / insufficient credits** — check your account's remaining character
  quota (Settings → Usage); STT and TTS draw from the same plan quota.
- **429 / rate limited** — back off and retry; sustained heavy voice traffic
  may need a higher ElevenLabs plan tier.
- **Empty transcript** — check the audio file isn't corrupted/empty before
  assuming a language-support problem; `processVoiceJob.ts` logs
  `detectedLanguageCode`/`confidence`/`sizeBytes` diagnostics whenever
  transcription comes back empty.
- **Invalid voice ID** — the `ELEVENLABS_VOICE_ID_DEFAULT` (or a company's
  `defaultVoiceByLanguage` entry) must be a voice ID that exists and is
  accessible on the account the API key belongs to.

## Rotating the key

Generate a new key in the ElevenLabs dashboard, update the Cloudflare secret
(`wrangler secret put ELEVENLABS_API_KEY`), redeploy, then revoke the old key
once the new one is confirmed working.

## Switching to another provider

`GoogleSpeechToTextProvider`/`GoogleTextToSpeechProvider` (see
`GOOGLE_SPEECH_SETUP.md`) and `WhisperSpeechToTextProvider` remain in
`packages/speech` as working alternative implementations of the same
interfaces. Swapping the default is a change to
`apps/workers/voice-consumer/src/worker.ts`'s composition root only.
