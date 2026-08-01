# GOOGLE_SPEECH_SETUP.md

Covers Google Cloud Text-to-Speech (voice replies). Speech-to-text
(transcribing inbound voice notes) uses OpenAI Whisper instead -- set
`OPENAI_API_KEY` as a Cloudflare Worker secret (`wrangler secret put
OPENAI_API_KEY`); no other setup is required for it. See
`docs/architecture/adr-0005-speech-provider-architecture.md` for why.

## 1. Create a Google Cloud project and service account

1. Create (or reuse) a Google Cloud project.
2. Enable the **Cloud Text-to-Speech API**.
3. Create a service account with the `roles/speech.client` role (or a
   narrower custom role limited to the TTS API).
4. Create a JSON key for the service account.

## 2. Configure environment variables

```
GOOGLE_CLOUD_PROJECT_ID=<your-project-id>
GOOGLE_CLOUD_CREDENTIALS=<the full service-account JSON, as a single-line string>
GOOGLE_STT_LOCATION=global
GOOGLE_TTS_VOICE_DEFAULT=en-US-Neural2-C
```

Store `GOOGLE_CLOUD_CREDENTIALS` as a Cloudflare Worker secret in production
(`wrangler secret put GOOGLE_CLOUD_CREDENTIALS`), never as a plain `[vars]`
entry, and never in a committed file.

## How authentication works

Unlike most Node-based integrations, `packages/speech` does **not** depend on
the official `google-auth-library` (which assumes a Node-specific runtime).
Instead, `packages/speech/src/googleAuth.ts` implements the OAuth2
service-account JWT-bearer flow from scratch on top of the Web Crypto API
(`globalThis.crypto.subtle`), which is available in both Node.js 20+ and the
Cloudflare Workers runtime:

1. `parseGoogleServiceAccountJson` parses `GOOGLE_CLOUD_CREDENTIALS`.
2. `createSignedGoogleJwt` builds and RS256-signs a JWT assertion.
3. `fetchGoogleAccessToken` exchanges that assertion for a bearer access token
   at Google's OAuth2 token endpoint.

This is covered by a genuine cryptographic round-trip test
(`packages/speech/test/googleAuth.test.ts`): it generates a real RSA keypair,
signs a JWT with the private key, and verifies the signature with the public
key using the same Web Crypto primitives the adapter uses in production.

## Wiring the providers

```typescript
import {
  fetchGoogleAccessToken,
  GoogleTextToSpeechProvider,
  WhisperSpeechToTextProvider,
} from "@dravonix/speech";

const getAccessToken = async () => {
  const { access_token } = await fetchGoogleAccessToken(
    serviceAccount,
    "https://www.googleapis.com/auth/cloud-platform",
  );
  return access_token;
};

const stt = new WhisperSpeechToTextProvider({ apiKey: env.OPENAI_API_KEY });
const tts = new GoogleTextToSpeechProvider({
  getAccessToken,
  defaultVoice: env.GOOGLE_TTS_VOICE_DEFAULT,
});
```

A production composition root should cache the Google access token until
shortly before its `expires_in` elapses rather than fetching a new one per
request (Whisper needs no such token -- it's a plain bearer API key).

## Without credentials

If `GOOGLE_CLOUD_CREDENTIALS` is unset, `env.googleSpeechConfigured` is
`false` and the composition root should select `MockTextToSpeechProvider`
instead (`packages/speech/src/providers/mockProvider.ts`), which returns
deterministic results with no network call. Same for `OPENAI_API_KEY` unset
and `MockSpeechToTextProvider`.

## Language configuration

TTS requests OGG/Opus output directly (`audioConfig.audioEncoding =
"OGG_OPUS"`) so no transcoding step is needed before sending a WhatsApp voice
reply, and pick a language-specific voice from the company's
`defaultVoiceByLanguage` setting.

Whisper (STT) auto-detects the spoken language itself and is not sent a
language hint -- forcing one based on the company's configured primary
language would hurt accuracy whenever a customer speaks a different one of
their enabled languages, which is exactly the case multi-language support
exists for (e.g. Malayalam-English mixed speech, Master Prompt section 5).

## Outstanding: real accuracy validation

STT accuracy on real audio (not yet re-validated against Whisper since the
switch from Google STT documented in ADR-0005) and Hindi/Arabic transcription
generally still need verification against real recorded samples in each
supported language before considering the voice feature complete.
