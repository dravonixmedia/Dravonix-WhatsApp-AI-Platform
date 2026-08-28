import { loadEnv } from "@dravonix/config";
import { createLogger, type LogContext } from "@dravonix/observability";

/** Never includes a stack trace or the error's raw payload/cause -- only name and message. */
function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorType: error.name, errorMessage: error.message };
  }
  return { errorType: "unknown" };
}

/**
 * Structured, safe failure logging for repository/Server Action error paths
 * (P1 stabilization: deadline-recovery audit found several rethrow sites with
 * no logging at all). This never swallows the CALLER's error -- callers still
 * `throw` (or return their own safe error result) immediately after calling
 * this; it only makes the failure observable before that happens.
 *
 * `context` accepts the shared correlation fields already used across
 * apps/api and apps/workers/* (companyId, conversationId, etc.); `extra`
 * accepts anything else safe to log for this specific call site (e.g.
 * leadId, action, operation). Every field still passes through
 * @dravonix/observability's redactSecrets as defense-in-depth, but that is
 * not a substitute for never passing phone numbers, message/email content,
 * tokens, secrets, or raw webhook payloads here in the first place.
 *
 * This function itself is best-effort and MUST NEVER throw: `loadEnv` can
 * throw `EnvValidationError` (e.g. a misconfigured staging/production
 * environment), and callers such as sendInvitationEmail/sendSupportEmails
 * are documented and tested to never throw solely because email delivery or
 * its supporting environment configuration failed. A logging failure must
 * not be allowed to turn that best-effort contract into an unhandled
 * exception, so any failure here (env validation, logger construction, or
 * serialization) is swallowed silently rather than surfaced -- the caller's
 * own error (or safe error result) remains the only thing observable from a
 * failed operation.
 */
export function logServerError(
  message: string,
  error: unknown,
  context: Partial<Omit<LogContext, "environment">> = {},
  extra: Record<string, unknown> = {},
): void {
  try {
    const env = loadEnv(process.env);
    const logger = createLogger({ environment: env.APP_ENV, ...context });
    logger.error(message, { ...safeErrorDetails(error), ...extra });
  } catch {
    // Best-effort only -- see doc comment above. Intentionally silent: there
    // is nothing safe left to log about a failure of the logging path
    // itself without risking exposing env validation details, and the
    // caller's own error is unaffected either way.
  }
}
