import { ConversationAlreadyClaimedError, PermissionDeniedError } from "@dravonix/core";
import { describe, expect, it } from "vitest";
import { assignToMe, endHumanAssistance, startHumanConversation } from "../src/service.js";
import { FakeHandoverRepository } from "./fakeHandoverRepository.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const CONVERSATION_ID = "conv-1";
const AGENT_1 = "agent-1";
const AGENT_2 = "agent-2";

function repoWithOneUnassignedHandover(): FakeHandoverRepository {
  return new FakeHandoverRepository(
    [{ id: CONVERSATION_ID, companyId: COMPANY_A, state: "handover_requested" }],
    [
      { id: AGENT_1, companyId: COMPANY_A, permissions: ["conversations.assign"] },
      { id: AGENT_2, companyId: COMPANY_A, permissions: ["conversations.assign"] },
      { id: "outsider", companyId: COMPANY_B, permissions: ["conversations.assign"] },
    ],
  );
}

describe("assignToMe", () => {
  it("rejects a caller who is not a member of the conversation's company (tenant isolation)", async () => {
    const repo = repoWithOneUnassignedHandover();
    repo.asMember("outsider");
    await expect(assignToMe(repo, CONVERSATION_ID)).rejects.toThrow(PermissionDeniedError);
  });

  it("rejects a caller who lacks conversations.assign", async () => {
    const repo = new FakeHandoverRepository(
      [{ id: CONVERSATION_ID, companyId: COMPANY_A, state: "handover_requested" }],
      [{ id: AGENT_1, companyId: COMPANY_A, permissions: [] }],
    );
    repo.asMember(AGENT_1);
    await expect(assignToMe(repo, CONVERSATION_ID)).rejects.toThrow(PermissionDeniedError);
  });

  it("claims an unassigned handover for the caller", async () => {
    const repo = repoWithOneUnassignedHandover();
    repo.asMember(AGENT_1);
    const result = await assignToMe(repo, CONVERSATION_ID);
    expect(result.assignedMemberId).toBe(AGENT_1);
    expect(result.state).toBe("human_active");
  });

  it("a second caller racing the same claim is rejected as already claimed, not silently reassigned", async () => {
    const repo = repoWithOneUnassignedHandover();
    repo.asMember(AGENT_1);
    await assignToMe(repo, CONVERSATION_ID);

    repo.asMember(AGENT_2);
    await expect(assignToMe(repo, CONVERSATION_ID)).rejects.toThrow(
      ConversationAlreadyClaimedError,
    );
    // The original claim is untouched by the losing racer.
    expect(repo.getConversationState(CONVERSATION_ID).assignedMemberId).toBe(AGENT_1);
  });
});

describe("startHumanConversation concurrency (final plan section 8)", () => {
  it("case B: the first of two employees racing an unassigned handover claims and starts it", async () => {
    const repo = repoWithOneUnassignedHandover();
    repo.asMember(AGENT_1);
    const result = await startHumanConversation(repo, CONVERSATION_ID);
    expect(result.assignedMemberId).toBe(AGENT_1);
    expect(result.state).toBe("human_active");
  });

  it("case C: the losing racer without the reassign override is rejected, never silently co-starts it", async () => {
    const repo = repoWithOneUnassignedHandover();
    repo.asMember(AGENT_1);
    await startHumanConversation(repo, CONVERSATION_ID);

    repo.asMember(AGENT_2);
    await expect(startHumanConversation(repo, CONVERSATION_ID)).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(repo.getConversationState(CONVERSATION_ID).assignedMemberId).toBe(AGENT_1);
  });

  it("case C: a caller holding conversations.reassign may explicitly take over from the first assignee", async () => {
    const repo = new FakeHandoverRepository(
      [{ id: CONVERSATION_ID, companyId: COMPANY_A, state: "handover_requested" }],
      [
        { id: AGENT_1, companyId: COMPANY_A, permissions: ["conversations.assign"] },
        {
          id: AGENT_2,
          companyId: COMPANY_A,
          permissions: ["conversations.assign", "conversations.reassign"],
        },
      ],
    );
    repo.asMember(AGENT_1);
    await startHumanConversation(repo, CONVERSATION_ID);

    repo.asMember(AGENT_2);
    const result = await startHumanConversation(repo, CONVERSATION_ID);
    expect(result.assignedMemberId).toBe(AGENT_2);
  });
});

describe("endHumanAssistance", () => {
  it("clears assignment/reason and returns to ai_active without touching ai_mode", async () => {
    const repo = new FakeHandoverRepository(
      [
        {
          id: CONVERSATION_ID,
          companyId: COMPANY_A,
          state: "human_active",
          assignedMemberId: AGENT_1,
          handoverReason: "customer requested a refund",
          aiMode: "paused",
        },
      ],
      [{ id: AGENT_1, companyId: COMPANY_A, permissions: ["conversations.assign"] }],
    );
    repo.asMember(AGENT_1);

    const result = await endHumanAssistance(repo, CONVERSATION_ID);

    expect(result.state).toBe("ai_active");
    expect(result.assignedMemberId).toBeNull();
    expect(result.handoverReason).toBeNull();
    // A prior Pause AI action must survive End human assistance -- resuming AI is always a separate, explicit action.
    expect(result.aiMode).toBe("paused");
  });

  it("works even when nobody was ever assigned (declining a handover)", async () => {
    const repo = new FakeHandoverRepository(
      [{ id: CONVERSATION_ID, companyId: COMPANY_A, state: "handover_requested" }],
      [{ id: AGENT_1, companyId: COMPANY_A, permissions: ["conversations.assign"] }],
    );
    repo.asMember(AGENT_1);
    const result = await endHumanAssistance(repo, CONVERSATION_ID);
    expect(result.state).toBe("ai_active");
  });
});
