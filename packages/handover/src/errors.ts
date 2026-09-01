import {
  AppError,
  ConversationAlreadyClaimedError,
  ConversationNotAssignedToCallerError,
  InvalidStateTransitionError,
  PermissionDeniedError,
  UnauthorizedError,
} from "@dravonix/core";

/**
 * Domain errors for the fixed RPC exception vocabulary (final plan section 4)
 * that don't already have a matching class in @dravonix/core. Kept local to
 * this package rather than added to core, since core's error taxonomy is
 * meant to stay generic and these are specific to the handover RPC surface.
 */
export class HandoverConversationNotFoundError extends AppError {
  constructor(public readonly conversationId: string) {
    super("conversation_not_found", `Conversation ${conversationId} was not found`);
  }
}

export class HandoverTargetMemberNotFoundError extends AppError {
  constructor(public readonly targetMemberId: string) {
    super(
      "target_member_not_found",
      `Target member ${targetMemberId} was not found or is not active`,
    );
  }
}

export class HandoverConversationNotAssignedError extends AppError {
  constructor(public readonly conversationId: string) {
    super(
      "conversation_not_assigned",
      `Conversation ${conversationId} is not yet assigned to anyone -- claim it first`,
    );
  }
}

export class HandoverMessageNotFoundError extends AppError {
  constructor(public readonly messageId: string) {
    super(
      "message_not_found",
      `Message ${messageId} was not found or is not eligible for this action`,
    );
  }
}

export class HandoverNotReservationOwnerError extends AppError {
  constructor(public readonly messageId: string) {
    super("not_reservation_owner", `Message ${messageId} was reserved by a different team member`);
  }
}

export class HandoverInvalidResolutionError extends AppError {
  constructor(public readonly resolution: string) {
    super("invalid_resolution", `"${resolution}" is not a valid reconciliation resolution`);
  }
}

export class HandoverIdempotencyKeyRequiredError extends AppError {
  constructor() {
    super("idempotency_key_required", "An idempotency key is required for this action");
  }
}

export class HandoverSourceMessageMismatchError extends AppError {
  constructor(public readonly sourceMessageId: string) {
    super(
      "source_message_mismatch",
      `Source message ${sourceMessageId} does not belong to the target conversation/company`,
    );
  }
}

export class HandoverInvalidSourceTypeError extends AppError {
  constructor(public readonly sourceType: string) {
    super("invalid_source_type", `"${sourceType}" is not a valid handover source type`);
  }
}

/**
 * Meta/WhatsApp Batch 2, Phase 8: thrown by sendHumanReply when the WhatsApp
 * 24-hour customer service window has closed for this conversation. A human
 * agent's ordinary free-form reply is never sent, and never falsely marked
 * as sent, when this is thrown -- no reservation is even created. The
 * message text matches the task's own specified UX copy exactly, since it
 * is shown to the agent as-is.
 */
export class WhatsAppServiceWindowClosedError extends AppError {
  constructor(public readonly conversationId: string) {
    super(
      "whatsapp_service_window_closed",
      "The WhatsApp customer service window has expired. An approved template is required before free-form replies can resume.",
    );
  }
}

/**
 * Thrown by reconcileAiOutboundMessage (the trusted, server-only AI-message
 * reconciliation path) when the target message was not sent by the AI --
 * human-agent messages must go through the ordinary authenticated
 * reconcileOutboundMessage path instead, never this service-role-only one.
 */
export class HandoverNotAnAiMessageError extends AppError {
  constructor(
    public readonly messageId: string,
    public readonly actualSenderType: string,
  ) {
    super(
      "not_an_ai_message",
      `Message ${messageId} was not sent by the AI (sender_type: ${actualSenderType}) -- use the ordinary reconciliation action instead`,
    );
  }
}

const RPC_ERROR_CODES = [
  "unauthorized",
  "not_a_member",
  "permission_denied",
  "conversation_not_found",
  "conversation_already_claimed",
  "conversation_not_assigned",
  "conversation_not_assigned_to_caller",
  "target_member_not_found",
  "invalid_state_transition",
  "invalid_status_transition",
  "invalid_resolution",
  "invalid_source_type",
  "idempotency_key_required",
  "source_message_mismatch",
  "source_message_not_found",
  "message_not_found",
  "not_reservation_owner",
] as const;

type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

function extractRpcErrorCode(error: unknown): RpcErrorCode | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (!message) return null;
  const trimmed = message.trim();
  return (RPC_ERROR_CODES as readonly string[]).includes(trimmed)
    ? (trimmed as RpcErrorCode)
    : null;
}

export interface HandoverRpcErrorContext {
  companyId?: string;
  conversationId?: string;
  messageId?: string;
  targetMemberId?: string;
  /** Best-effort label of the permission the calling RPC checks, for PermissionDeniedError's message. */
  permission?: string;
  /** Name of the RPC that was called, used only for InvalidStateTransitionError's message. */
  rpc: string;
}

/**
 * Translates the fixed exception-message vocabulary raised by migration 12's
 * SECURITY DEFINER functions (delivered as a bare error.message by
 * supabase-js/postgrest, e.g. "conversation_already_claimed") into a typed
 * AppError apps/api's error mapping can key off of. Falls back to rethrowing
 * the original error unchanged for anything outside the fixed vocabulary
 * (a real, unexpected failure -- never silently swallowed or reclassified).
 */
export function mapHandoverRpcError(error: unknown, context: HandoverRpcErrorContext): Error {
  const code = extractRpcErrorCode(error);
  if (code === null) return error instanceof Error ? error : new Error(String(error));

  switch (code) {
    case "unauthorized":
      return new UnauthorizedError();
    case "not_a_member":
    case "permission_denied":
      return new PermissionDeniedError(
        context.companyId ?? "unknown",
        context.permission ?? context.rpc,
      );
    case "conversation_not_found":
      return new HandoverConversationNotFoundError(context.conversationId ?? "unknown");
    case "conversation_already_claimed":
      return new ConversationAlreadyClaimedError(context.conversationId ?? "unknown");
    case "conversation_not_assigned":
      return new HandoverConversationNotAssignedError(context.conversationId ?? "unknown");
    case "conversation_not_assigned_to_caller":
      return new ConversationNotAssignedToCallerError(context.conversationId ?? "unknown");
    case "target_member_not_found":
      return new HandoverTargetMemberNotFoundError(context.targetMemberId ?? "unknown");
    case "invalid_state_transition":
    case "invalid_status_transition":
      return new InvalidStateTransitionError(
        context.conversationId ?? context.messageId ?? "unknown",
        context.rpc,
      );
    case "invalid_resolution":
      return new HandoverInvalidResolutionError(context.rpc);
    case "invalid_source_type":
      return new HandoverInvalidSourceTypeError(context.rpc);
    case "idempotency_key_required":
      return new HandoverIdempotencyKeyRequiredError();
    case "source_message_mismatch":
    case "source_message_not_found":
      return new HandoverSourceMessageMismatchError(context.conversationId ?? "unknown");
    case "message_not_found":
      return new HandoverMessageNotFoundError(context.messageId ?? "unknown");
    case "not_reservation_owner":
      return new HandoverNotReservationOwnerError(context.messageId ?? "unknown");
  }
}
