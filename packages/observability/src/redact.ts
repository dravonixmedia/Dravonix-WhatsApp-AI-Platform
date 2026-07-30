const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|api[_-]?key|access[_-]?key|authorization|credential|private[_-]?key)/i;

const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gi;

const REDACTED = "[REDACTED]";

/**
 * Recursively redacts values whose key looks sensitive (token, secret,
 * password, api_key, authorization, credential, private_key, ...), and masks
 * inline `Bearer <token>` occurrences in string values. Applied to every log
 * line before it is written (Master Prompt section 31: never log full API
 * keys, payment credentials, or authorization headers).
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(val);
    }
    return result;
  }
  return value;
}
