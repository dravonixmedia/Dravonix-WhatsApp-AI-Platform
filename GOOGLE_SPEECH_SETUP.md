# GOOGLE_SPEECH_SETUP.md

## 1. Create a Google Cloud project and service account

1. Create (or reuse) a Google Cloud project.
2. Enable the **Cloud Speech-to-Text API** and **Cloud Text-to-Speech API**.
3. Create a service account with the `roles/speech.client` role (or a
   narrower custom role limited to the speech/TTS APIs).
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
  GoogleSpeechToTextProvider,
  GoogleTextToSpeechProvider,
} from "@dravonix/speech";

const getAccessToken = async () => {
  const { access_token } = await fetchGoogleAccessToken(
    serviceAccount,
    "https://www.googleapis.com/auth/cloud-platform",
  );
  return access_token;
};

const stt = new GoogleSpeechToTextProvider({ getAccessToken });
const tts = new GoogleTextToSpeechProvider({
  getAccessToken,
  defaultVoice: env.GOOGLE_TTS_VOICE_DEFAULT,
});
```

A production composition root should cache the access token until shortly
before its `expires_in` elapses rather than fetching a new one per request.

## Without credentials

If `GOOGLE_CLOUD_CREDENTIALS` is unset, `env.googleSpeechConfigured` is
`false` and the composition root should select `MockSpeechToTextProvider` /
`MockTextToSpeechProvider` instead (`packages/speech/src/providers/mockProvider.ts`),
which return deterministic results with no network call.

## Language configuration

STT requests carry `languageCode` (primary hint) and
`alternativeLanguageCodes` (e.g. English as an alternative when the primary is
Malayalam, for Malayalam-English mixed speech — Master Prompt section 5), both
sourced from the company's `enabled_languages` setting. TTS requests OGG/Opus
output directly (`audioConfig.audioEncoding = "OGG_OPUS"`) so no transcoding
step is needed before sending a WhatsApp voice reply.

## Outstanding: real accuracy validation

Malayalam, Hindi, and Arabic transcription accuracy has **not** been validated
against real audio samples in this development environment (no physical audio
files or live credential available). Before considering the voice feature
complete, record real sample audio in each supported language and verify
transcription quality manually, per Master Prompt section 5.
