/**
 * Identifies one of our own domain errors by its stable `.code` string
 * rather than `instanceof`. Next.js/OpenNext can bundle a Server Action's
 * (or, confirmed separately, a Server Component's) dependency graph more
 * than once in the single deployed Cloudflare Worker artifact -- an error
 * class exported from a shared/workspace module, or even one defined
 * locally in this app, is not guaranteed to satisfy `instanceof` against
 * the class reference a different call site's bundled copy holds, even
 * though both originate from the exact same source file. Confirmed
 * directly against this app's own built OpenNext output for
 * WhatsAppServiceWindowClosedError/NoServiceWindowFallbackTemplateError
 * (packages/handover) and, separately, for NoCompanyAccessError (this
 * app's own lib/session.ts) and the shared AppError base class -- all
 * appear as multiple independent class definitions in the shipped worker.
 *
 * `instanceof Error` remains safe on its own: `Error` is a language
 * intrinsic shared within one JS realm regardless of bundling. `.code` is
 * a plain data property set identically by every bundled copy of a given
 * error class, so an exact string match on it is unaffected by which copy
 * constructed the thrown object.
 */
export function isDomainError(error: unknown, code: string): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code === code
  );
}
