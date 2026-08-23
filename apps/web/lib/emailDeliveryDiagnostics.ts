import { loadEnv } from "@dravonix/config";

export interface EmailDeliveryDiagnostics {
  zeptoMailTokenPresent: boolean;
  emailFromAddressPresent: boolean;
  emailFromNamePresent: boolean;
  appUrlPresent: boolean;
  emailConfigured: boolean;
}

/**
 * Presence-only diagnostic for the invitation-email provider config
 * (packages/config/src/env.ts) -- reports whether each required value was
 * actually bound to *this* running Worker, never the value itself.
 *
 * `APP_URL` and `EMAIL_FROM_NAME` both have a `z.string().default(...)` in
 * the env schema (deliberately, so every other environment/dev machine
 * doesn't need to set them). That means `loadEnv(source).APP_URL` and
 * `.EMAIL_FROM_NAME` are *always* truthy after parsing, whether or not
 * Cloudflare actually bound a value -- checking the resolved, defaulted
 * value would report "Present" even when the real binding is completely
 * missing (confirmed against a real staging run: the diagnostic first
 * shipped this way and silently masked a genuinely missing binding).
 * `source` (the raw, pre-default input) is checked directly for these two
 * fields instead. `ZEPTOMAIL_API_TOKEN`/`EMAIL_API_KEY` (resolved as
 * `emailApiToken`) and `EMAIL_FROM_ADDRESS` have no schema default, so their
 * post-`loadEnv()` value is already an accurate presence signal.
 */
export function getEmailDeliveryDiagnostics(
  source: Record<string, string | undefined>,
): EmailDeliveryDiagnostics {
  const env = loadEnv(source);
  return {
    zeptoMailTokenPresent: Boolean(env.emailApiToken),
    emailFromAddressPresent: Boolean(env.EMAIL_FROM_ADDRESS),
    emailFromNamePresent: Boolean(source.EMAIL_FROM_NAME),
    appUrlPresent: Boolean(source.APP_URL),
    emailConfigured: env.emailConfigured,
  };
}
