import type { LeadUpdates } from "./schema.js";

/**
 * Merges AI-extracted lead updates into existing lead state, never overwriting
 * an already-known field with null/undefined (Master Prompt section 15: the
 * system must avoid re-asking for information already supplied). The AI is
 * still allowed to overwrite a field with a new non-null value (e.g. the
 * customer changing their budget).
 */
export function mergeLeadUpdates(
  existing: Record<string, unknown>,
  updates: LeadUpdates | null,
): Record<string, unknown> {
  if (!updates) return existing;

  const merged = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== null && value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
