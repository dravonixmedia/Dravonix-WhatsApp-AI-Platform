/**
 * Sanitizes a research query before it may ever leave the platform to a web
 * research provider. Two complementary checks run:
 *  1. Pattern-based detection of generically-shaped sensitive data (phone
 *     numbers, UUID-style internal IDs, credential-looking tokens) that
 *     could appear in a query regardless of context.
 *  2. Context-based exact-value detection: the caller supplies the actual
 *     private values in play for this turn (phone number, conversation id,
 *     etc.) and this function checks the query does not literally contain
 *     them -- catching leakage that a generic pattern could miss or a
 *     pattern could false-positive on.
 * Detected values are redacted from the returned `query`; nothing here ever
 * calls a research provider -- this is a pure text transform.
 */

export type QuerySanitizationViolationType =
  | "phone_number"
  | "internal_id"
  | "credential"
  | "conversation_history"
  | "private_document_reference";

export interface QuerySanitizationViolation {
  type: QuerySanitizationViolationType;
  /** The exact matched/redacted substring, for logging categorization only -- never persisted verbatim in production research audit logs. */
  match: string;
}

export interface SanitizedQuery {
  /** The query with every detected violation redacted -- safe to send to a research provider only when `safe` is also true. */
  query: string;
  violations: QuerySanitizationViolation[];
  /** true only when zero violations were detected. */
  safe: boolean;
}

export interface QuerySanitizationContext {
  phoneNumber?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  /** Secrets/API keys that must never appear in an outbound query, e.g. provider credentials accidentally present in surrounding context. */
  credentials?: string[];
  /** Prior message bodies from this conversation -- a query must describe the general topic, never quote conversation history verbatim. */
  conversationHistorySnippets?: string[];
  /** Filenames/storage keys of private customer documents. */
  privateDocumentReferences?: string[];
}

const REDACTED = "[redacted]";

const PHONE_NUMBER_PATTERN = /\+?\d[\d\s().-]{6,}\d/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CREDENTIAL_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|secret|password|bearer\s+[a-z0-9._-]+|sk-[a-z0-9]{8,})\b/gi;

/** Minimum length before a supplied history/document string is considered a meaningful leak signal (avoids false positives on trivially short values). */
const MIN_CONTEXT_MATCH_LENGTH = 8;

function redactPattern(
  query: string,
  pattern: RegExp,
  type: QuerySanitizationViolationType,
  violations: QuerySanitizationViolation[],
): string {
  return query.replace(pattern, (match) => {
    violations.push({ type, match });
    return REDACTED;
  });
}

function redactExactValue(
  query: string,
  value: string | null | undefined,
  type: QuerySanitizationViolationType,
  violations: QuerySanitizationViolation[],
): string {
  if (!value || value.length < MIN_CONTEXT_MATCH_LENGTH || !query.includes(value)) {
    return query;
  }
  violations.push({ type, match: value });
  return query.split(value).join(REDACTED);
}

export function sanitizeResearchQuery(
  rawQuery: string,
  context: QuerySanitizationContext = {},
): SanitizedQuery {
  const violations: QuerySanitizationViolation[] = [];
  let query = rawQuery;

  // Context-supplied exact values run FIRST and take priority: they are the
  // most specific, highest-confidence signal (the caller knows exactly what
  // this turn's private values are), and running them first stops a
  // known-private value from being partially consumed -- and mis-typed -- by
  // a broader generic pattern below (e.g. an internal ID's digit run being
  // swallowed by the phone-number heuristic before it can be recognized as
  // an internal ID).
  query = redactExactValue(query, context.phoneNumber, "phone_number", violations);
  query = redactExactValue(query, context.conversationId, "internal_id", violations);
  query = redactExactValue(query, context.contactId, "internal_id", violations);
  query = redactExactValue(query, context.companyId, "internal_id", violations);
  for (const credential of context.credentials ?? []) {
    query = redactExactValue(query, credential, "credential", violations);
  }
  for (const snippet of context.conversationHistorySnippets ?? []) {
    query = redactExactValue(query, snippet, "conversation_history", violations);
  }
  for (const reference of context.privateDocumentReferences ?? []) {
    query = redactExactValue(query, reference, "private_document_reference", violations);
  }

  // Generic pattern-based detection runs on whatever remains. UUID before
  // phone number: a UUID's hyphenated digit/hex groups can otherwise be
  // partially matched by the broader phone-number shape first, misclassifying
  // (and mangling) an internal ID as a phone number.
  query = redactPattern(query, UUID_PATTERN, "internal_id", violations);
  query = redactPattern(query, PHONE_NUMBER_PATTERN, "phone_number", violations);
  query = redactPattern(query, CREDENTIAL_PATTERN, "credential", violations);

  return { query: query.trim(), violations, safe: violations.length === 0 };
}
