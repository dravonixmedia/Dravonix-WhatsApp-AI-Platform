import { z } from "zod";

/**
 * Centralized, validated environment configuration.
 *
 * Every process (apps/web, apps/api, apps/workers/*) calls `loadEnv(source)` once at
 * startup. Validation failures throw immediately with a clear message rather than
 * letting the app boot into an unsafe or half-configured state.
 *
 * Secrets are never given defaults here; only genuinely public, non-sensitive
 * defaults (branding, model IDs, mode flags) may have one.
 */

const appEnvSchema = z.enum(["development", "test", "staging", "production"]);

const rawEnvSchema = z.object({
  APP_ENV: appEnvSchema.default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:8787"),

  PLATFORM_PRODUCT_NAME: z.string().optional(),
  PLATFORM_SHORT_NAME: z.string().optional(),
  PLATFORM_COMPANY_NAME: z.string().optional(),
  PLATFORM_SUPPORT_EMAIL: z.string().email().optional(),
  PLATFORM_WEBSITE_URL: z.string().url().optional(),

  DEV_TENANT_SELECTOR_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_DATABASE_URL: z.string().optional(),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_TEST_WABA_ID: z.string().optional(),
  META_TEST_PHONE_NUMBER_ID: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v21.0"),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().default(1024),

  GOOGLE_CLOUD_PROJECT_ID: z.string().optional(),
  GOOGLE_CLOUD_CREDENTIALS: z.string().optional(),
  GOOGLE_STT_LOCATION: z.string().default("global"),
  GOOGLE_TTS_VOICE_DEFAULT: z.string().default("en-US-Neural2-C"),

  // ElevenLabs is the default voice provider (both STT and TTS) -- see
  // docs/architecture/adr-0005-speech-provider-architecture.md. The GOOGLE_*
  // vars above remain for GoogleSpeechToTextProvider/GoogleTextToSpeechProvider,
  // which stay available as an alternative implementation.
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID_DEFAULT: z.string().default("21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_TTS_MODEL_ID: z.string().default("eleven_multilingual_v2"),
  ELEVENLABS_STT_MODEL_ID: z.string().default("scribe_v1"),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_MODE: z.enum(["test", "live"]).default("test"),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().default("dravonix-media-dev"),

  ENCRYPTION_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

export type RawEnv = z.infer<typeof rawEnvSchema>;

export interface PlatformEnv extends RawEnv {
  isProduction: boolean;
  devTenantSelectorEnabled: boolean;
  whatsappConfigured: boolean;
  anthropicConfigured: boolean;
  googleSpeechConfigured: boolean;
  elevenLabsConfigured: boolean;
  razorpayConfigured: boolean;
  r2Configured: boolean;
}

export class EnvValidationError extends Error {
  constructor(issues: string) {
    super(`Invalid environment configuration:\n${issues}`);
    this.name = "EnvValidationError";
  }
}

/**
 * Parse and validate environment variables from an arbitrary source (process.env,
 * a Cloudflare Worker `env` binding object, etc).
 */
export function loadEnv(source: Record<string, string | undefined>): PlatformEnv {
  const parsed = rawEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new EnvValidationError(issues);
  }

  const raw = parsed.data;
  const isProduction = raw.APP_ENV === "production";

  if (isProduction && raw.DEV_TENANT_SELECTOR_ENABLED) {
    throw new EnvValidationError(
      "  - DEV_TENANT_SELECTOR_ENABLED must not be true when APP_ENV=production",
    );
  }

  if (isProduction && raw.RAZORPAY_MODE === "live" && !raw.RAZORPAY_KEY_SECRET) {
    throw new EnvValidationError(
      "  - RAZORPAY_MODE=live requires RAZORPAY_KEY_SECRET to be configured",
    );
  }

  return {
    ...raw,
    isProduction,
    devTenantSelectorEnabled: raw.APP_ENV === "development" && raw.DEV_TENANT_SELECTOR_ENABLED,
    whatsappConfigured: Boolean(
      raw.META_ACCESS_TOKEN && raw.META_TEST_PHONE_NUMBER_ID && raw.META_APP_SECRET,
    ),
    anthropicConfigured: Boolean(raw.ANTHROPIC_API_KEY),
    googleSpeechConfigured: Boolean(raw.GOOGLE_CLOUD_CREDENTIALS),
    elevenLabsConfigured: Boolean(raw.ELEVENLABS_API_KEY),
    razorpayConfigured: Boolean(raw.RAZORPAY_KEY_ID && raw.RAZORPAY_KEY_SECRET),
    r2Configured: Boolean(raw.R2_ACCOUNT_ID && raw.R2_ACCESS_KEY_ID && raw.R2_SECRET_ACCESS_KEY),
  };
}
