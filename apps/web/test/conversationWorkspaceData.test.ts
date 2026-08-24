import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getConversationThreadForDashboard = vi.fn();
const deriveAiLikelyProcessing = vi.fn((..._args: unknown[]) => false);
vi.mock("@dravonix/handover", () => ({
  getConversationThreadForDashboard: (...args: unknown[]) =>
    getConversationThreadForDashboard(...args),
  deriveAiLikelyProcessing: (...args: unknown[]) => deriveAiLikelyProcessing(...args),
}));

vi.mock("@dravonix/config", () => ({
  loadEnv: () => ({ APP_ENV: "test" }),
}));

vi.mock("@dravonix/observability", () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  notFound: (...args: unknown[]) => notFound(...(args as [])),
}));

const loadContactSummary = vi.fn(async (..._args: unknown[]) => ({
  contactId: "contact-1",
  displayName: "Jane",
  maskedPhoneNumber: "+1••••1234",
  phoneVisibility: "masked" as const,
  lastDetectedLanguage: null,
  contactCreatedAt: "2026-01-01T00:00:00.000Z",
  timezone: null,
}));
vi.mock("../app/dashboard/loadContactSummary.js", () => ({
  loadContactSummary: (...args: unknown[]) => loadContactSummary(...args),
}));

const COMPANY_ID = "company-1";
const CONVERSATION_ID = "conversation-1";

function fakeSupabase(membersData: unknown[] = []): {
  client: SupabaseClient;
  from: ReturnType<typeof vi.fn>;
} {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    then: (resolve: (v: { data: unknown }) => unknown) => resolve({ data: membersData }),
  };
  const from = vi.fn(() => chain);
  return { client: { from } as unknown as SupabaseClient, from };
}

const threadResult = {
  conversation: {
    id: CONVERSATION_ID,
    aiMode: "active",
    state: "human_active",
    assignedMemberId: null,
    handoverReason: null,
  },
  thread: {
    hasMore: false,
    messages: [
      {
        id: "m1",
        direction: "inbound",
        senderType: "customer",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "m2",
        direction: "outbound",
        senderType: "ai",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ],
  },
};

describe("loadConversationWorkspaceData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls getConversationThreadForDashboard with (repo, companyId, conversationId) -- the single tenant-checked entry point, never a second query path", async () => {
    const { loadConversationWorkspaceData } =
      await import("../app/dashboard/conversationWorkspaceData.js");
    getConversationThreadForDashboard.mockResolvedValueOnce(threadResult);
    const { client } = fakeSupabase();
    const repo = { marker: "repo" };

    await loadConversationWorkspaceData(client, repo as never, {
      companyId: COMPANY_ID,
      conversationId: CONVERSATION_ID,
      canAssignConversations: false,
    });

    expect(getConversationThreadForDashboard).toHaveBeenCalledWith(
      repo,
      COMPANY_ID,
      CONVERSATION_ID,
    );
  });

  it("loads the contact via the shared, Phase-3A-compliant loadContactSummary -- never a raw contacts/whatsapp_wa_id query of its own", async () => {
    const { loadConversationWorkspaceData } =
      await import("../app/dashboard/conversationWorkspaceData.js");
    getConversationThreadForDashboard.mockResolvedValueOnce(threadResult);
    const { client } = fakeSupabase();
    const repo = {};

    await loadConversationWorkspaceData(client, repo as never, {
      companyId: COMPANY_ID,
      conversationId: CONVERSATION_ID,
      canAssignConversations: false,
    });

    expect(loadContactSummary).toHaveBeenCalledWith(client, CONVERSATION_ID);
  });

  it("derives aiLikelyProcessing from the latest inbound and latest AI outbound message timestamps", async () => {
    const { loadConversationWorkspaceData } =
      await import("../app/dashboard/conversationWorkspaceData.js");
    getConversationThreadForDashboard.mockResolvedValueOnce(threadResult);
    const { client } = fakeSupabase();

    await loadConversationWorkspaceData(client, {} as never, {
      companyId: COMPANY_ID,
      conversationId: CONVERSATION_ID,
      canAssignConversations: false,
    });

    expect(deriveAiLikelyProcessing).toHaveBeenCalledWith({
      aiMode: "active",
      latestInboundAt: "2026-01-01T00:00:00.000Z",
      latestAiOutboundAt: "2026-01-01T00:01:00.000Z",
    });
  });

  it("never queries company_members when the caller cannot assign conversations", async () => {
    const { loadConversationWorkspaceData } =
      await import("../app/dashboard/conversationWorkspaceData.js");
    getConversationThreadForDashboard.mockResolvedValueOnce(threadResult);
    const { client, from } = fakeSupabase();

    const result = await loadConversationWorkspaceData(client, {} as never, {
      companyId: COMPANY_ID,
      conversationId: CONVERSATION_ID,
      canAssignConversations: false,
    });

    expect(from).not.toHaveBeenCalledWith("company_members");
    expect(result.members).toBeNull();
  });

  it("queries company_members, scoped to companyId, only when the caller can assign conversations", async () => {
    const { loadConversationWorkspaceData } =
      await import("../app/dashboard/conversationWorkspaceData.js");
    getConversationThreadForDashboard.mockResolvedValueOnce(threadResult);
    const { client, from } = fakeSupabase([{ id: "m1", role: "sales_person" }]);

    const result = await loadConversationWorkspaceData(client, {} as never, {
      companyId: COMPANY_ID,
      conversationId: CONVERSATION_ID,
      canAssignConversations: true,
    });

    expect(from).toHaveBeenCalledWith("company_members");
    expect(result.members).toEqual([{ id: "m1", role: "sales_person" }]);
  });

  it("calls notFound() (never re-throws the raw error) when the conversation is missing, cross-tenant, or otherwise inaccessible -- and never proceeds to load the contact", async () => {
    const { loadConversationWorkspaceData } =
      await import("../app/dashboard/conversationWorkspaceData.js");
    getConversationThreadForDashboard.mockRejectedValueOnce(new Error("not found in this tenant"));
    const { client } = fakeSupabase();

    await expect(
      loadConversationWorkspaceData(client, {} as never, {
        companyId: COMPANY_ID,
        conversationId: CONVERSATION_ID,
        canAssignConversations: false,
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFound).toHaveBeenCalledTimes(1);
    expect(loadContactSummary).not.toHaveBeenCalled();
  });
});
