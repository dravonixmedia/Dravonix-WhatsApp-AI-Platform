import {
  ConversationAlreadyClaimedError,
  PermissionDeniedError,
  UnauthorizedError,
} from "@dravonix/core";
import { describe, expect, it } from "vitest";
import { HandoverTargetMemberNotFoundError, mapHandoverRpcError } from "../src/errors.js";

describe("mapHandoverRpcError", () => {
  it("maps a bare 'unauthorized' RPC exception to UnauthorizedError", () => {
    const mapped = mapHandoverRpcError(new Error("unauthorized"), { rpc: "handover_assign_to_me" });
    expect(mapped).toBeInstanceOf(UnauthorizedError);
  });

  it("maps 'permission_denied' to PermissionDeniedError carrying the calling RPC's permission label", () => {
    const mapped = mapHandoverRpcError(new Error("permission_denied"), {
      companyId: "company-1",
      rpc: "handover_assign_to_me",
      permission: "conversations.assign",
    });
    expect(mapped).toBeInstanceOf(PermissionDeniedError);
    expect((mapped as PermissionDeniedError).permission).toBe("conversations.assign");
  });

  it("maps 'conversation_already_claimed' to ConversationAlreadyClaimedError", () => {
    const mapped = mapHandoverRpcError(new Error("conversation_already_claimed"), {
      conversationId: "conv-1",
      rpc: "handover_assign_to_me",
    });
    expect(mapped).toBeInstanceOf(ConversationAlreadyClaimedError);
    expect((mapped as ConversationAlreadyClaimedError).conversationId).toBe("conv-1");
  });

  it("maps 'target_member_not_found' to a handover-specific error carrying the target member id", () => {
    const mapped = mapHandoverRpcError(new Error("target_member_not_found"), {
      targetMemberId: "member-9",
      rpc: "handover_assign_to_member",
    });
    expect(mapped).toBeInstanceOf(HandoverTargetMemberNotFoundError);
    expect((mapped as HandoverTargetMemberNotFoundError).targetMemberId).toBe("member-9");
  });

  it("passes through an unrecognized error unchanged (never silently reclassified)", () => {
    const original = new Error("some unrelated database error");
    const mapped = mapHandoverRpcError(original, { rpc: "handover_assign_to_me" });
    expect(mapped).toBe(original);
  });
});
