import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioral tests for the P2 knowledge ingestion Server Actions
 * (lib/actions/adminCompanyConfig.ts's knowledge functions). Dynamically
 * invokes the real exported actions, mocking only their external module
 * boundaries (platform session, Supabase client, Next.js revalidation, and
 * server logging) -- the same module-boundary-mocking convention already
 * established by mediaAudioRoute.test.ts/billingPaymentActions.test.ts in
 * this codebase. @dravonix/knowledge's prepareKnowledgeChunks/
 * FileTooLargeError are NOT mocked -- this test exercises the real cleaning/
 * chunking/size-limit implementation, not a stub of it.
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

const { adminAddKnowledgeSourceAction, adminReingestKnowledgeSourceAction } =
  await import("../lib/actions/adminCompanyConfig.js");

const SUPER_ADMIN_SESSION = { platformRole: "super_admin", userId: "staff-1" };
const COMPANY_ID = "company-a";
const SOURCE_ID = "source-1";

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
      return Promise.resolve({
        data: [{ id: SOURCE_ID, title: "T", source_type: "faq" }],
        error: null,
      });
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

describe("adminAddKnowledgeSourceAction", () => {
  it("valid text: creates metadata-only, then ingests the real prepared chunks", async () => {
    await adminAddKnowledgeSourceAction(
      COMPANY_ID,
      formData({
        title: "Pricing",
        source_type: "pricing",
        content: "Our starter package costs 25000.",
      }),
    );

    expect(rpc).toHaveBeenCalledWith("admin_add_knowledge_source", {
      p_company_id: COMPANY_ID,
      p_source_type: "pricing",
      p_title: "Pricing",
    });
    const ingestCall = rpc.mock.calls.find((c) => c[0] === "ingest_knowledge_source");
    expect(ingestCall).toBeTruthy();
    expect(ingestCall?.[1]).toMatchObject({
      p_company_id: COMPANY_ID,
      p_source_id: SOURCE_ID,
      p_chunks: ["Our starter package costs 25000."],
    });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("FAQ source type: creates the source with that type and still ingests", async () => {
    await adminAddKnowledgeSourceAction(
      COMPANY_ID,
      formData({ title: "FAQ", source_type: "faq", content: "We are open on weekends." }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "admin_add_knowledge_source",
      expect.objectContaining({ p_source_type: "faq" }),
    );
    expect(rpc).toHaveBeenCalledWith("ingest_knowledge_source", expect.anything());
  });

  it("no content submitted: creates metadata only, never calls ingest_knowledge_source", async () => {
    await adminAddKnowledgeSourceAction(
      COMPANY_ID,
      formData({ title: "Later", source_type: "faq" }),
    );
    expect(rpc).toHaveBeenCalledWith("admin_add_knowledge_source", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("ingest_knowledge_source", expect.anything());
  });

  it("whitespace-only content: treated the same as no content -- never calls ingest_knowledge_source", async () => {
    await adminAddKnowledgeSourceAction(
      COMPANY_ID,
      formData({ title: "Blank", source_type: "faq", content: "   \n\t  " }),
    );
    expect(rpc).not.toHaveBeenCalledWith("ingest_knowledge_source", expect.anything());
  });

  it("oversized content: ingest_knowledge_source is called with zero chunks and the safe size-limit message, never the raw content", async () => {
    const oversized = "a".repeat(21 * 1024 * 1024); // over the 20 MB limit
    await adminAddKnowledgeSourceAction(
      COMPANY_ID,
      formData({ title: "Huge", source_type: "faq", content: oversized }),
    );
    const ingestCall = rpc.mock.calls.find((c) => c[0] === "ingest_knowledge_source");
    expect(ingestCall).toBeTruthy();
    expect(ingestCall?.[1]).toMatchObject({
      p_chunks: [],
      p_empty_error: "Content exceeds the allowed size.",
    });
    expect(JSON.stringify(ingestCall?.[1])).not.toContain("aaaa");
  });

  it("a genuine infrastructure failure during ingestion is logged safely (no content/chunks) and rethrown", async () => {
    const infraError = new Error("connection reset");
    rpc.mockImplementation((name: string) => {
      if (name === "admin_add_knowledge_source") {
        return Promise.resolve({ data: [{ id: SOURCE_ID }], error: null });
      }
      if (name === "ingest_knowledge_source") {
        return Promise.resolve({ data: null, error: infraError });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await expect(
      adminAddKnowledgeSourceAction(
        COMPANY_ID,
        formData({
          title: "Fails",
          source_type: "faq",
          content: "Some real secret-looking content",
        }),
      ),
    ).rejects.toThrow("connection reset");

    expect(logServerError).toHaveBeenCalledTimes(1);
    const [message, loggedError, context, extra] = logServerError.mock.calls[0] ?? [];
    expect(message).toBe("Failed to ingest knowledge source content");
    expect(loggedError).toBe(infraError);
    expect(context).toEqual({ companyId: COMPANY_ID });
    expect(extra).toMatchObject({
      operation: "ingestKnowledgeSourceContent",
      knowledgeSourceId: SOURCE_ID,
    });
    expect(JSON.stringify(logServerError.mock.calls[0])).not.toContain("secret-looking content");
  });
});

describe("adminReingestKnowledgeSourceAction", () => {
  it("successful replacement: ingests the real prepared chunks for the given source", async () => {
    await adminReingestKnowledgeSourceAction(
      COMPANY_ID,
      formData({ source_id: SOURCE_ID, source_type: "faq", content: "Updated answer content." }),
    );
    expect(rpc).toHaveBeenCalledWith("ingest_knowledge_source", {
      p_company_id: COMPANY_ID,
      p_source_id: SOURCE_ID,
      p_chunks: ["Updated answer content."],
    });
  });

  it("invalid (whitespace-only) replacement still calls the RPC with zero chunks -- the RPC's own last-known-good rule is the actual safety guarantee", async () => {
    await adminReingestKnowledgeSourceAction(
      COMPANY_ID,
      formData({ source_id: SOURCE_ID, source_type: "faq", content: "   " }),
    );
    expect(rpc).toHaveBeenCalledWith("ingest_knowledge_source", {
      p_company_id: COMPANY_ID,
      p_source_id: SOURCE_ID,
      p_chunks: [],
    });
  });

  it("tab/newline/CR-only replacement is treated identically to plain-space-only -- zero chunks reach the RPC", async () => {
    await adminReingestKnowledgeSourceAction(
      COMPANY_ID,
      formData({ source_id: SOURCE_ID, source_type: "faq", content: "\t\r\n\t\r\n" }),
    );
    expect(rpc).toHaveBeenCalledWith("ingest_knowledge_source", {
      p_company_id: COMPANY_ID,
      p_source_id: SOURCE_ID,
      p_chunks: [],
    });
  });

  it("propagates a wrong source/company rejection from the RPC rather than swallowing it", async () => {
    const notFoundError = Object.assign(new Error("knowledge_source_not_found"), {
      message: "knowledge_source_not_found",
    });
    rpc.mockImplementation((name: string) =>
      name === "ingest_knowledge_source"
        ? Promise.resolve({ data: null, error: notFoundError })
        : Promise.resolve({ data: null, error: null }),
    );

    await expect(
      adminReingestKnowledgeSourceAction(
        COMPANY_ID,
        formData({ source_id: "wrong-source", source_type: "faq", content: "x" }),
      ),
    ).rejects.toThrow("knowledge_source_not_found");
  });

  it("a genuine infrastructure failure is logged safely and rethrown", async () => {
    const infraError = new Error("timeout");
    rpc.mockImplementation((name: string) =>
      name === "ingest_knowledge_source"
        ? Promise.resolve({ data: null, error: infraError })
        : Promise.resolve({ data: null, error: null }),
    );

    await expect(
      adminReingestKnowledgeSourceAction(
        COMPANY_ID,
        formData({ source_id: SOURCE_ID, source_type: "faq", content: "real content" }),
      ),
    ).rejects.toThrow("timeout");

    expect(logServerError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logServerError.mock.calls[0])).not.toContain("real content");
  });
});
