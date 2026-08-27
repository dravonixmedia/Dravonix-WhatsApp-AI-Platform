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
 * no logging at all). This never swallows the error -- callers still `throw`
 * (or return their own safe error result) immediately after calling this; it
 * only makes the failure observable before that happens.
 *
 * `context` accepts the shared correlation fields already used across
 * apps/api and apps/workers/* (companyId, conversationId, etc.); `extra`
 * accepts anything else safe to log for this specific call site (e.g.
 * leadId, action, operation). Every field still passes through
 * @dravonix/observability's redactSecrets as defense-in-depth, but that is
 * not a substitute for never passing phone numbers, message/email content,
 * tokens, secrets, or raw webhook payloads here in the first place.
 */
export function logServerError(
  message: string,
  error: unknown,
  context: Partial<Omit<LogContext, "environment">> = {},
  extra: Record<string, unknown> = {},
): void {
  const env = loadEnv(process.env);
  const logger = createLogger({ environment: env.APP_ENV, ...context });
  logger.error(message, { ...safeErrorDetails(error), ...extra });
}
