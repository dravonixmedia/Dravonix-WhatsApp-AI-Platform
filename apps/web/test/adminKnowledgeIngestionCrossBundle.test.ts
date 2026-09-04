import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DravonixKnowledge from "@dravonix/knowledge";

/**
 * Cross-bundle regression coverage for adminCompanyConfig.ts's knowledge
 * ingestion Server Actions, part of the same Batch 2 hardening pass that
 * replaced `error instanceof WhatsAppServiceWindowClosedError` with a
 * stable `.code` check (see apps/web/lib/domainError.ts). This occurrence
 * (`error instanceof FileTooLargeError`, apps/web/lib/actions/
 * adminCompanyConfig.ts) has the exact same structural shape: the throw
 * (inside @dravonix/knowledge's prepareKnowledgeChunks) and the catch (in
 * this file's own ingestKnowledgeSourceContent helper, called by the
 * exported Server Actions below) are compiled together in one Server
 * Action's own file, which Next.js/OpenNext can bundle more than once.
 *
 * Kept in its own file (rather than added to adminKnowledgeIngestion.test.ts)
 * specifically because that file deliberately exercises the REAL
 * prepareKnowledgeChunks/FileTooLargeError implementation unmocked; this
 * file needs to mock @dravonix/knowledge to construct a duplicate-bundle
 * stand-in, which cannot coexist with that file's own module-level mocks.
 */

const getPlatformSession = vi.fn();
vi.mock("../lib/session.js", () => ({
  getPlatformSession: (...args: unknown[]) => getPlatformSession(...args),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

const rpc = vi.fn();
const createServerSupabaseClient = vi.fn(async () => ({ rpc }));
vi.mock("../lib/supabase/server.js", () => ({
  createServerSupabaseClient: () => createServerSupabaseClient(),
}));

const logServerError = vi.fn();
vi.mock("../lib/serverLogging.js", () => ({
  logServerError: (...args: unknown[]) => logServerError(...args),
}));

const prepareKnowledgeChunks = vi.fn();
vi.mock("@dravonix/knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof DravonixKnowledge>();
  return {
    ...actual,
    prepareKnowledgeChunks: (...args: unknown[]) => prepareKnowledgeChunks(...args),
  };
});

const { adminAddKnowledgeSourceAction } = await import("../lib/actions/adminCompanyConfig.js");
const { FileTooLargeError, FILE_TOO_LARGE_CODE } = await import("@dravonix/knowledge");

const SUPER_ADMIN_SESSION = { platformRole: "super_admin", userId: "staff-1" };
const COMPANY_ID = "company-a";
const SOURCE_ID = "source-1";

/**
 * Stands in for "the same FileTooLargeError, but constructed by a
 * different bundled copy of packages/knowledge/src/ingestion.ts" -- not
 * imported from @dravonix/knowledge and not extending its real class, so
 * it can never satisfy `instanceof` against it. Only `.code` equality can
 * recognize it.
 */
class DuplicateBundleFileTooLargeError extends Error {
  constructor(public readonly code: string) {
    super("File exceeds the allowed size (duplicate-bundle stand-in)");
  }
}

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  getPlatformSession.mockResolvedValue(SUPER_ADMIN_SESSION);
  rpc.mockImplementation((name: string) => {
    if (name === "admin_add_knowledge_source") {
      return Promise.resolve({ data: [{ id: SOURCE_ID }], error: null });
    }
    if (name === "ingest_knowledge_source") {
      return Promise.resolve({
        data: [{ id: SOURCE_ID, ingestion_status: "ready", ingestion_error: null }],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
});

describe("adminAddKnowledgeSourceAction cross-bundle FileTooLargeError identification", () => {
  it("control: the duplicate-bundle stand-in is never `instanceof` the real FileTooLargeError -- pins the exact mechanism", () => {
    const duplicate = new DuplicateBundleFileTooLargeError(FILE_TOO_LARGE_CODE);
    expect(duplicate).not.toBeInstanceOf(FileTooLargeError);
    expect(duplicate).toBeInstanceOf(Error);
    expect(duplicate.code).toBe(FILE_TOO_LARGE_CODE);
  });

  it("still treats a structurally-identical but non-instanceof duplicate as oversized content, not an infrastructure failure", async () => {
    prepareKnowledgeChunks.mockImplementation(() => {
      throw new DuplicateBundleFileTooLargeError(FILE_TOO_LARGE_CODE);
    });

    await adminAddKnowledgeSourceAction(
      COMPANY_ID,
      formData({ title: "Huge", source_type: "faq", content: "irrelevant, chunking is mocked" }),
    );

    const ingestCall = rpc.mock.calls.find((c) => c[0] === "ingest_knowledge_source");
    expect(ingestCall).toBeTruthy();
    expect(ingestCall?.[1]).toMatchObject({
      p_chunks: [],
      p_empty_error: "Content exceeds the allowed size.",
    });
    expect(logServerError).not.toHaveBeenCalled();
  });

  it("a duplicate-class error with an unrelated code is still logged and rethrown, never misclassified as oversized content", async () => {
    const unrelated = new DuplicateBundleFileTooLargeError("some_other_error");
    prepareKnowledgeChunks.mockImplementation(() => {
      throw unrelated;
    });

    await expect(
      adminAddKnowledgeSourceAction(
        COMPANY_ID,
        formData({ title: "Fails", source_type: "faq", content: "some content" }),
      ),
    ).rejects.toBe(unrelated);

    expect(rpc).not.toHaveBeenCalledWith("ingest_knowledge_source", expect.anything());
  });

  it("adminCompanyConfig.ts no longer identifies FileTooLargeError via instanceof", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const actionsSource = readFileSync(
      join(here, "..", "lib/actions/adminCompanyConfig.ts"),
      "utf8",
    );
    expect(actionsSource).not.toMatch(/instanceof FileTooLargeError/);
    expect(actionsSource).toMatch(/isDomainError\(error, FILE_TOO_LARGE_CODE\)/);
  });
});
